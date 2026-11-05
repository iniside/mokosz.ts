import type { Mastra } from '@mastra/core'
import type { Pool } from 'pg'
import type { Profile } from '../llm/profiles.ts'
import { RunRecorder } from '../llm/recorder.ts'
import { MEMORY } from '../mastra/memory.ts'
import { saveMessage } from '../mastra/workflows/qa.ts'
import { AnswerSchema, type Answer } from '../mastra/workflows/state.ts'
import { registerRunContext, type EventSink } from '../mastra/workflows/wrap.ts'
import { oneLine } from '../text.ts'
import { appendEvent, finishRun, startRun, type RunTotals } from './conversations.ts'
import type { Database } from './transaction.ts'

export const SHUTDOWN = 'interrupted by shutdown'

type WorkflowRun = Awaited<ReturnType<ReturnType<Mastra['getWorkflow']>['createRun']>>

/** Set until cleared; a wait on a set signal returns at once. */
export class Changed {
  #set = false
  #waiters = new Set<() => void>()

  set(): void {
    this.#set = true
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  clear(): void {
    this.#set = false
  }

  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.#set) return
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const onAbort = (): void => reject(signal?.reason)
    this.#waiters.add(resolve)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await promise
    } finally {
      this.#waiters.delete(resolve)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

export interface Listener {
  readonly changed: Changed
  close(): void
}

export class RunSignals {
  readonly #waiters = new Map<string, Set<Changed>>()

  listen(runId: string): Listener {
    const changed = new Changed()
    let waiters = this.#waiters.get(runId)
    if (waiters === undefined) {
      waiters = new Set()
      this.#waiters.set(runId, waiters)
    }
    waiters.add(changed)
    return {
      changed,
      close: () => {
        waiters.delete(changed)
        if (waiters.size === 0 && this.#waiters.get(runId) === waiters) this.#waiters.delete(runId)
      },
    }
  }

  listeners(runId: string): number {
    return this.#waiters.get(runId)?.size ?? 0
  }

  notify(runId: string): void {
    for (const changed of this.#waiters.get(runId) ?? []) changed.set()
  }
}

export interface RunTask {
  readonly controller: AbortController
  done: Promise<void>
  run: WorkflowRun | null
}

/** A workflow run's failure, rebuilt from the error Mastra hands over serialised. */
class StepFailure extends Error {
  constructor(fields: object) {
    const message: unknown = Reflect.get(fields, 'message')
    const name: unknown = Reflect.get(fields, 'name')
    const stack: unknown = Reflect.get(fields, 'stack')
    super(typeof message === 'string' ? message : '')
    this.name = typeof name === 'string' ? name : 'Error'
    if (typeof stack === 'string') this.stack = stack
  }
}

function totals(recorder: RunRecorder, started: number): RunTotals {
  const usage = recorder.totals()
  return {
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd: usage.costUsd,
    latencyMs: Math.round(performance.now() - started),
    path: [...recorder.path],
    models: usage.models,
  }
}

/** "<ErrorName>: <one-line message>", or the name alone. */
export function errorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  const text = oneLine(error instanceof Error ? error.message : String(error))
  return text === '' ? name : `${name}: ${text}`
}

/** The sink of a stored run: each event is appended under the run's lock, then `notify` runs. */
export function storeSink(
  db: Database,
  runId: string,
  signal: AbortSignal,
  notify: () => void,
): EventSink {
  return {
    emit: async (type, payload) => {
      await appendEvent(db, runId, type, payload, { signal })
      notify()
    },
  }
}

export class Executor {
  readonly mastra: Mastra
  readonly pool: Pool
  readonly signals = new RunSignals()
  readonly tasks = new Map<string, RunTask>()

  constructor(mastra: Mastra, pool: Pool) {
    this.mastra = mastra
    this.pool = pool
  }

  async start(conversationId: string, question: string, profile: Profile): Promise<string> {
    const memory = this.mastra.getMemory(MEMORY)
    const runId = await startRun(this.pool, memory, {
      conversationId,
      question,
      profile: profile.name,
    })
    const task: RunTask = { controller: new AbortController(), done: Promise.resolve(), run: null }
    task.done = this.#settle(runId, this.#run(runId, conversationId, question, profile, task))
    this.tasks.set(runId, task)
    return runId
  }

  /** The task's done callback: it leaves the registry, and a run it could not finish is logged. */
  async #settle(runId: string, running: Promise<void>): Promise<void> {
    let failure: { error: unknown } | null = null
    try {
      await running
    } catch (error) {
      failure = { error }
    }
    this.tasks.delete(runId)
    if (failure !== null) console.error(`run ${runId} could not be finished`, failure.error)
  }

  async shutdown(): Promise<void> {
    const tasks = [...this.tasks.values()]
    for (const task of tasks) task.controller.abort()
    await Promise.allSettled(tasks.map(async (task) => task.run?.cancel()))
    await Promise.allSettled(tasks.map((task) => task.done))
  }

  async #drive(
    runId: string,
    conversationId: string,
    question: string,
    profile: Profile,
    recorder: RunRecorder,
    task: RunTask,
  ): Promise<Answer> {
    const { signal } = task.controller
    await saveMessage(this.mastra.getMemory(MEMORY), conversationId, 'user', question, signal)
    const release = registerRunContext(runId, {
      profile,
      recorder,
      sink: storeSink(this.pool, runId, signal, () => this.signals.notify(runId)),
      pool: this.pool,
      signal,
    })
    try {
      const run = await this.mastra.getWorkflow('qa').createRun({ runId })
      task.run = run
      signal.throwIfAborted()
      const result = await run.start({ inputData: { conversation_id: conversationId } })
      if (result.status === 'success') return AnswerSchema.parse(result.result)
      if (result.status === 'failed') throw new StepFailure(result.error)
      throw new Error(`the workflow run ended ${result.status}`)
    } finally {
      release()
    }
  }

  async #finish(
    runId: string,
    runTotals: RunTotals,
    outcome: { final: Answer } | { error: string },
  ): Promise<void> {
    await finishRun(this.pool, runId, runTotals, outcome)
    this.signals.notify(runId)
  }

  async #run(
    runId: string,
    conversationId: string,
    question: string,
    profile: Profile,
    task: RunTask,
  ): Promise<void> {
    const started = performance.now()
    const recorder = new RunRecorder()
    let final: Answer
    try {
      final = await this.#drive(runId, conversationId, question, profile, recorder, task)
    } catch (error) {
      if (task.controller.signal.aborted) {
        await this.#finish(runId, totals(recorder, started), { error: SHUTDOWN })
        return
      }
      console.error(`run ${runId} failed`, error)
      await this.#finish(runId, totals(recorder, started), { error: errorMessage(error) })
      return
    }
    await this.#finish(runId, totals(recorder, started), { final })
  }
}
