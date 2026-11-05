import { AssertionError } from 'node:assert'
import { MockLanguageModelV4 } from 'ai/test'
import { NODE_OPTIONS } from '../../src/llm/models.ts'

export type CallOptions = MockLanguageModelV4['doGenerateCalls'][number]

/**
 * Queued outputs per node, returned by mock models that replace the
 * providers' models while the script is active; the request goes through the agent and our
 * parsing, the provider's HTTP call does not.
 */
export class ScriptedLLM {
  readonly queues = new Map<string, string[]>()
  readonly calls: CallOptions[] = []
  readonly missing: string[] = []
  /** Runs inside a node's model call, before its output is returned. */
  onGenerate: ((node: string) => void) | null = null

  queue(node: string, ...outputs: (string | object)[]): void {
    const texts = outputs.map((output) =>
      typeof output === 'string' ? output : JSON.stringify(output),
    )
    this.queues.set(node, [...(this.queues.get(node) ?? []), ...texts])
  }

  remaining(): Record<string, string[]> {
    return Object.fromEntries([...this.queues].filter(([, texts]) => texts.length > 0))
  }

  model(provider: string, modelId: string): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      provider,
      modelId,
      doGenerate: async (options) => {
        const scope = options.providerOptions?.[NODE_OPTIONS]
        const node = typeof scope?.node === 'string' ? scope.node : '(no node)'
        this.calls.push(options)
        this.onGenerate?.(node)
        const text = this.queues.get(node)?.shift()
        if (text === undefined) {
          this.missing.push(node)
          throw new AssertionError({ message: `no scripted output left for node ${node}` })
        }
        const prompt = options.prompt.flatMap((message) =>
          typeof message.content === 'string'
            ? [message.content]
            : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
        )
        const tokensIn = prompt.join('').length
        return {
          content: [{ type: 'text', text }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: tokensIn,
              noCache: tokensIn,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: text.length, text: text.length, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })
  }

  /** The fixture teardown. */
  finish(): void {
    if (this.missing.length > 0) {
      throw new AssertionError({
        message: `nodes called without a scripted output: ${JSON.stringify(this.missing)}`,
      })
    }
    const remaining = this.remaining()
    if (Object.keys(remaining).length > 0) {
      throw new AssertionError({
        message: `scripted outputs not consumed: ${JSON.stringify(remaining)}`,
      })
    }
  }
}

let active: ScriptedLLM | null = null

export function startScript(): ScriptedLLM {
  active = new ScriptedLLM()
  return active
}

export function stopScript(): ScriptedLLM | null {
  const script = active
  active = null
  return script
}

/** Wraps a provider factory so its models are scripted while a script is active. */
export function scripted<A extends unknown[], P extends (modelId: string) => unknown>(
  create: (...args: A) => P,
  provider: string,
): (...args: A) => P {
  return (...args) =>
    new Proxy(create(...args), {
      apply(target, thisArg, argArray: [string]) {
        if (active === null) return Reflect.apply(target, thisArg, argArray)
        return active.model(provider, argArray[0])
      },
    })
}

/** The `scriptedLlm` fixture: the script is active for the test and checked at teardown. */
export function scriptedLlmFixture(
  _context: object,
  { onCleanup }: { onCleanup: (cleanup: () => void) => void },
): ScriptedLLM {
  const script = startScript()
  onCleanup(() => {
    stopScript()
    script.finish()
  })
  return script
}
