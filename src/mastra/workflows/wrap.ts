import type { Mastra } from '@mastra/core'
import type { Pool } from 'pg'
import type { Profile } from '../../llm/profiles.ts'
import type { RunRecorder } from '../../llm/recorder.ts'

export type StepEventType = 'step_started' | 'step_finished'

export interface EventSink {
  emit(type: StepEventType, payload: Record<string, unknown>): Promise<void>
}

/** What a run's steps share in memory only: never in step data or the request context. */
export interface RunContext {
  readonly profile: Profile
  readonly recorder: RunRecorder
  readonly sink: EventSink
  readonly pool: Pool
  readonly signal: AbortSignal
}

const contexts = new Map<string, RunContext>()

/** Makes `context` the one the steps of run `runId` see; the returned function withdraws it. */
export function registerRunContext(runId: string, context: RunContext): () => void {
  if (contexts.has(runId)) throw new Error(`run ${runId} already has a RunContext`)
  contexts.set(runId, context)
  return () => {
    if (contexts.get(runId) === context) contexts.delete(runId)
  }
}

export function runContext(runId: string): RunContext {
  const context = contexts.get(runId)
  if (context === undefined) throw new TypeError(`workflow run ${runId} has no RunContext`)
  return context
}

export type NodeFn<I, O> = (input: I, context: RunContext, mastra: Mastra) => Promise<O>

interface StepParams<I> {
  readonly inputData: I
  readonly runId: string
  readonly mastra: Mastra
}

/**
 * The node joins the path and emits step_started before it runs; on success
 * it emits step_finished with the usage of its own calls and its latency; on failure nothing.
 */
export function wrap<I, O>(name: string, fn: NodeFn<I, O>): (params: StepParams<I>) => Promise<O> {
  return async ({ inputData, runId, mastra }) => {
    const context = runContext(runId)
    context.recorder.visit(name)
    await context.sink.emit('step_started', { node: name })
    const mark = context.recorder.mark()
    const started = performance.now()
    const output = await fn(inputData, context, mastra)
    const latencyMs = Math.round(performance.now() - started)
    const usage = context.recorder.since(mark)
    await context.sink.emit('step_finished', {
      node: name,
      model: usage.models.at(-1) ?? null,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      latency_ms: latencyMs,
    })
    return output
  }
}
