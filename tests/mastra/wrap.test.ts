import { randomUUID } from 'node:crypto'
import { Mastra } from '@mastra/core'
import { Pool } from 'pg'
import { describe, expect, test, vi } from 'vitest'
import { loadProfile } from '../../src/llm/profiles.ts'
import type { LLMCall } from '../../src/llm/recorder.ts'
import { Decimal } from '../../src/decimal.ts'
import { registerRunContext, wrap, type RunContext } from '../../src/mastra/workflows/wrap.ts'
import { MemorySink, newTurn } from './qa-harness.ts'

function call(node: string, model: string, tokensIn: number, tokensOut: number): LLMCall {
  const cost = new Decimal(0)
  return { node, model, tokensIn, tokensOut, latencyMs: 1, costUsd: cost, error: null }
}

async function register(
  sink: MemorySink,
  onTestFinished: (fn: () => void) => void,
): Promise<{ runId: string; context: RunContext }> {
  const turn = newTurn()
  const context: RunContext = {
    profile: await loadProfile('local-qwen'),
    recorder: turn.recorder,
    sink,
    pool: new Pool(),
    signal: new AbortController().signal,
  }
  onTestFinished(registerRunContext(turn.runId, context))
  return { runId: turn.runId, context }
}

const mastra = new Mastra({ logger: false })

describe('wrap', () => {
  test('step_finished carries the calls since the step started and the last model', async ({
    onTestFinished,
  }) => {
    const sink = new MemorySink()
    const { runId, context } = await register(sink, onTestFinished)
    context.recorder.record(call('router', 'before', 5, 5))
    let seenAtStart: unknown[] = []
    const step = wrap('answerer', async (input: string, ctx) => {
      seenAtStart = [...sink.events]
      ctx.recorder.record(call('answerer', 'first', 3, 4))
      ctx.recorder.record(call('answerer', 'second', 10, 20))
      return `${input}!`
    })

    const output = await step({ inputData: 'x', runId, mastra })

    expect(seenAtStart).toEqual([['step_started', { node: 'answerer' }]])
    expect(output).toBe('x!')
    expect(context.recorder.path).toEqual(['answerer'])
    expect(sink.events).toEqual([
      ['step_started', { node: 'answerer' }],
      [
        'step_finished',
        {
          node: 'answerer',
          model: 'second',
          tokens_in: 13,
          tokens_out: 24,
          latency_ms: expect.any(Number),
        },
      ],
    ])
  })

  test.for([
    [2.5, 3],
    [3.5, 4],
    [2.4999, 2],
    [2.5001, 3],
    [0.5, 1],
  ] as const)(
    'a step that takes %f ms reports latency_ms %i, rounded half up',
    async ([elapsed, latency], { onTestFinished }) => {
      const sink = new MemorySink()
      const { runId } = await register(sink, onTestFinished)
      const now = vi.spyOn(performance, 'now')
      onTestFinished(() => now.mockRestore())
      const step = wrap('verifier', async () => {
        now.mockReturnValue(1000 + elapsed)
        return null
      })
      now.mockReturnValue(1000)

      await step({ inputData: null, runId, mastra })

      expect(sink.events.at(-1)).toEqual([
        'step_finished',
        { node: 'verifier', model: null, tokens_in: 0, tokens_out: 0, latency_ms: latency },
      ])
    },
  )

  test('a failing step is in the path and emits only step_started', async ({ onTestFinished }) => {
    const sink = new MemorySink()
    const { runId, context } = await register(sink, onTestFinished)
    const step = wrap('router', async () => {
      throw new Error('boom')
    })

    await expect(step({ inputData: null, runId, mastra })).rejects.toThrow('boom')

    expect(context.recorder.path).toEqual(['router'])
    expect(sink.events).toEqual([['step_started', { node: 'router' }]])
  })

  test('a step of a run without a context runs nothing and touches no other run', async ({
    onTestFinished,
  }) => {
    const sink = new MemorySink()
    const { context } = await register(sink, onTestFinished)
    let ran = false
    const step = wrap('router', async () => {
      ran = true
      return 'never'
    })
    const runId = randomUUID()

    await expect(step({ inputData: null, runId, mastra })).rejects.toThrow(
      new TypeError(`workflow run ${runId} has no RunContext`),
    )

    expect(ran).toBe(false)
    expect(context.recorder.path).toEqual([])
    expect(sink.timeline).toEqual([])
  })
})
