import { Hono } from 'hono'
import { eventsAfter, type RunEvent } from '../runs/conversations.ts'
import type { AppState } from './state.ts'
import { parse, SeqSchema, UuidSchema } from './validation.ts'

export const PING_INTERVAL_MS = 15_000
export const KEEPALIVE = ': ping\n\n'

// seq is an int4 column: a larger `after` is clamped so it selects nothing instead of failing.
const MAX_SEQ = 2_147_483_647

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  'x-accel-buffering': 'no',
}

export function frame(event: RunEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\nid: ${event.seq}\n\n`
}

type Send = (frame: string) => void

const encoder = new TextEncoder()

/**
 * What `produce` sends, with a keep-alive comment after every idle interval; a client disconnect
 * aborts `closed`, which ends `produce` without touching the run.
 */
function eventStream(
  pingIntervalMs: number,
  produce: (send: Send, closed: AbortSignal) => Promise<void>,
): ReadableStream {
  const stop = new AbortController()
  let timer: NodeJS.Timeout | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string): void => {
        if (stop.signal.aborted) return
        controller.enqueue(encoder.encode(text))
        clearTimeout(timer)
        timer = setTimeout(() => write(KEEPALIVE), pingIntervalMs)
      }
      timer = setTimeout(() => write(KEEPALIVE), pingIntervalMs)
      void (async () => {
        try {
          await produce(write, stop.signal)
        } catch (error) {
          clearTimeout(timer)
          if (stop.signal.aborted) return
          console.error('Exception in the event stream', error)
          controller.error(error)
          return
        }
        clearTimeout(timer)
        if (!stop.signal.aborted) controller.close()
      })()
    },
    cancel() {
      clearTimeout(timer)
      stop.abort()
    },
  })
}

export function runRoutes(state: AppState, pingIntervalMs: number): Hono {
  const routes = new Hono()

  routes.get('/runs/:run_id/events', async (c) => {
    const runId = parse(c, UuidSchema, c.req.param('run_id'))
    if (!runId.ok) return runId.response
    const after = parse(c, SeqSchema, c.req.query('after'), 'after')
    if (!after.ok) return after.response
    const lastEventId = parse(c, SeqSchema, c.req.header('last-event-id'), 'Last-Event-ID')
    if (!lastEventId.ok) return lastEventId.response
    const start = Math.min(Math.max(after.value, lastEventId.value), MAX_SEQ)
    // Read before the stream starts: once streaming, the status line is already 200.
    const first = await eventsAfter(state.pool, runId.value, start)
    if (first === null) return c.json({ detail: 'run not found' }, 404)
    // Hono drops a HEAD body without cancelling it, so a stream would follow the run unread.
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: SSE_HEADERS })
    const body = eventStream(pingIntervalMs, async (send, closed) => {
      for (const event of first.events) send(frame(event))
      if (first.status !== 'running') return
      let last = first.events.at(-1)?.seq ?? start
      const listener = state.executor.signals.listen(runId.value)
      try {
        for (;;) {
          listener.changed.clear()
          const batch = await eventsAfter(state.pool, runId.value, last, { signal: closed })
          if (batch === null) return
          for (const event of batch.events) {
            send(frame(event))
            last = event.seq
          }
          // A terminal status read before the events means its terminal event was in the batch.
          if (batch.status !== 'running') return
          await listener.changed.wait(closed)
        }
      } finally {
        listener.close()
      }
    })
    return new Response(body, { status: 200, headers: SSE_HEADERS })
  })

  return routes
}
