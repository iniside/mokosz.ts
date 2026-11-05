import { useEffect, useRef, useState } from 'react'
import {
  runEventsUrl,
  type NodeName,
  type RunError,
  type StepFinished,
  type StepStarted,
} from '@/lib/api'

const MAX_RESUBSCRIBE = 5

export interface StepVisit {
  node: NodeName
  latencyMs: number | null
}

export type Connection = 'open' | 'reconnecting' | 'lost'

interface StreamState {
  runId: string
  visits: StepVisit[]
  connection: Connection
}

export interface RunStream {
  visits: StepVisit[]
  connection: Connection
}

export function useRunStream(
  runId: string | null,
  onEnd: (runId: string, error: string | null) => void,
): RunStream {
  const [state, setState] = useState<StreamState | null>(null)
  const [resubscribed, setResubscribed] = useState(0)
  const attempts = useRef<{ runId: string | null; n: number }>({ runId: null, n: 0 })
  const lastSeq = useRef<{ runId: string | null; seq: number }>({ runId: null, seq: 0 })
  const onEndRef = useRef(onEnd)
  useEffect(() => {
    onEndRef.current = onEnd
  })

  useEffect(() => {
    if (!runId) return
    if (attempts.current.runId !== runId) attempts.current = { runId, n: 0 }
    let reconnected = attempts.current.n > 0
    if (lastSeq.current.runId !== runId) lastSeq.current = { runId, seq: 0 }
    const source = new EventSource(runEventsUrl(runId, lastSeq.current.seq))
    let timer: number | undefined
    const update = (
      change: (visits: StepVisit[]) => StepVisit[],
      connection: Connection = 'open',
    ) =>
      setState((current) => {
        const visits = current?.runId === runId ? current.visits : []
        return { runId, visits: change(visits), connection }
      })
    const parse = <T>(event: MessageEvent<string>): T | null => {
      try {
        return JSON.parse(event.data) as T
      } catch {
        console.warn('Ignored a malformed run event', event.data)
        return null
      }
    }
    const fresh = (event: MessageEvent<string>) => {
      const seq = Number(event.lastEventId)
      if (seq <= lastSeq.current.seq) return false
      lastSeq.current.seq = seq
      if (reconnected) {
        reconnected = false
        attempts.current.n = 0
      }
      return true
    }
    const end = (error: string | null) => {
      source.close()
      onEndRef.current(runId, error)
    }

    source.addEventListener('step_started', (event) => {
      const message = event as MessageEvent<string>
      if (!fresh(message)) return
      const parsed = parse<StepStarted>(message)
      if (!parsed) return
      const { node } = parsed
      update((visits) => [...visits, { node, latencyMs: null }])
    })
    source.addEventListener('step_finished', (event) => {
      const message = event as MessageEvent<string>
      if (!fresh(message)) return
      const parsed = parse<StepFinished>(message)
      if (!parsed) return
      const { node, latency_ms } = parsed
      update((visits) => {
        const at = visits.findLastIndex((visit) => visit.node === node && visit.latencyMs === null)
        if (at < 0) return visits
        return visits.map((visit, i) => (i === at ? { ...visit, latencyMs: latency_ms } : visit))
      })
    })
    source.addEventListener('final', () => end(null))
    source.addEventListener('error', (event) => {
      // The run's `error` event is a MessageEvent; a dropped connection is a plain Event.
      if (event instanceof MessageEvent) {
        end(parse<RunError>(event as MessageEvent<string>)?.message ?? 'The run failed.')
        return
      }
      if (source.readyState !== EventSource.CLOSED) {
        update((visits) => visits, 'reconnecting')
        return
      }
      // The browser gave up; refetch, and if the run is still active this effect resubscribes.
      end(null)
      const n = attempts.current.n
      if (n >= MAX_RESUBSCRIBE) {
        update((visits) => visits, 'lost')
        return
      }
      update((visits) => visits, 'reconnecting')
      timer = window.setTimeout(
        () => {
          attempts.current.n = n + 1
          setResubscribed((count) => count + 1)
        },
        Math.min(1000 * 2 ** n, 10_000),
      )
    })
    return () => {
      source.close()
      window.clearTimeout(timer)
    }
  }, [runId, resubscribed])

  if (!runId || state?.runId !== runId) return { visits: [], connection: 'open' }
  return { visits: state.visits, connection: state.connection }
}
