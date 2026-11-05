import { describe, expect, test } from 'vitest'
import { errorMessage, RunSignals, type Changed } from '../../src/runs/executor.ts'

const WAIT_MS = 1000

async function within(pending: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`not done within ${WAIT_MS} ms`)), WAIT_MS)
  })
  try {
    await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// A wait on a set signal returns before it looks at the abort that follows; an unset one rejects.
async function isSet(changed: Changed): Promise<boolean> {
  const controller = new AbortController()
  const waiting = changed.wait(controller.signal).then(
    () => true,
    () => false,
  )
  controller.abort()
  return waiting
}

describe('run signals', () => {
  test('notify wakes only listeners of that run', async () => {
    const signals = new RunSignals()
    const [run, other] = [crypto.randomUUID(), crypto.randomUUID()]
    const first = signals.listen(run)
    const second = signals.listen(run)
    const third = signals.listen(other)
    try {
      signals.notify(run)

      expect(await isSet(first.changed)).toBe(true)
      expect(await isSet(second.changed)).toBe(true)
      expect(await isSet(third.changed)).toBe(false)
    } finally {
      for (const listener of [first, second, third]) listener.close()
    }
  })

  test('a notify before the wait is not lost', async () => {
    const signals = new RunSignals()
    const run = crypto.randomUUID()
    const changed = signals.listen(run)
    try {
      signals.notify(run)
      await within(changed.changed.wait())
    } finally {
      changed.close()
    }
  })

  test('a closed listener is no longer notified', async () => {
    const signals = new RunSignals()
    const run = crypto.randomUUID()

    const closed = signals.listen(run)
    closed.close()
    const open = signals.listen(run)
    try {
      signals.notify(run)

      expect(await isSet(open.changed)).toBe(true)
      expect(await isSet(closed.changed)).toBe(false)
    } finally {
      open.close()
    }
  })

  test('listeners counts the open listeners of a run', () => {
    const signals = new RunSignals()
    const run = crypto.randomUUID()
    const first = signals.listen(run)
    const second = signals.listen(run)

    expect(signals.listeners(run)).toBe(2)
    first.close()
    expect(signals.listeners(run)).toBe(1)
    second.close()
    expect(signals.listeners(run)).toBe(0)
  })

  test('a wait ends when its signal aborts', async () => {
    const signals = new RunSignals()
    const listener = signals.listen(crypto.randomUUID())
    const controller = new AbortController()
    const waiting = listener.changed.wait(controller.signal)

    controller.abort(new Error('closed'))

    await expect(waiting).rejects.toThrow('closed')
    listener.close()
  })
})

describe('error message', () => {
  class RuntimeError extends Error {
    override name = 'RuntimeError'
  }

  test.for([
    [new RuntimeError('embedder down'), 'RuntimeError: embedder down'],
    [new RuntimeError('a\n  b\tc '), 'RuntimeError: a b c'],
    [new RuntimeError(''), 'RuntimeError'],
    [new RuntimeError(' \n '), 'RuntimeError'],
  ] as const)('%s is written as %j', ([error, expected]) => {
    expect(errorMessage(error)).toBe(expected)
  })
})
