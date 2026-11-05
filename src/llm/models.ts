import { createAnthropic } from '@ai-sdk/anthropic'
import { Agent } from '@mastra/core/agent'
import { RequestContext } from '@mastra/core/request-context'
import { AISDKError, type LanguageModel } from 'ai'
import { createOllama } from 'ollama-ai-provider-v2'
import type { z } from 'zod'
import { Decimal } from '../decimal.ts'
import { getSettings, type Settings } from '../settings.ts'
import { describe, httpClient, type JsonBody } from './http.ts'
import { completionCost, NO_SAMPLING_PARAMS } from './prices.ts'
import {
  ANTHROPIC_PREFIX,
  isLocal,
  ollamaModel,
  type Node,
  type NodeConfig,
  type Profile,
} from './profiles.ts'
import type { LLMCall, RunRecorder } from './recorder.ts'

const MODEL_KEY = 'mokosz.model'
/** The provider options key that names the node; no provider reads it. */
export const NODE_OPTIONS = 'mokosz'

export class LLMError extends Error {
  override name = 'LLMError'
  readonly call: LLMCall

  constructor(message: string, call: LLMCall, options?: ErrorOptions) {
    super(message, options)
    this.call = call
  }
}

export interface LLMResult<T> {
  readonly parsed: T
  readonly model: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly latencyMs: number
  readonly costUsd: Decimal
}

export type ChatMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string }

export interface NodeAgent {
  readonly node: Node
  readonly agent: Agent
}

type Model = Extract<LanguageModel, { specificationVersion: 'v4' }>

function isModel(value: unknown): value is Model {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'specificationVersion') === 'v4'
  )
}

/**
 * The agent of a node. Its model is built per call from the profile and handed over in the
 * request context. Nothing is retried or repaired: Mastra's model retries default to 0, and its
 * default error processors (which retry timeouts) are turned off.
 */
export function nodeAgent(node: Node, instructions: string): NodeAgent {
  const agent = new Agent({
    id: node,
    name: node,
    instructions,
    errorProcessorDefaults: false,
    model: ({ requestContext }) => {
      const model = requestContext.get(MODEL_KEY)
      if (!isModel(model)) throw new TypeError(`the request context has no ${MODEL_KEY}`)
      return model
    },
  })
  return { node, agent }
}

// The provider has no keep_alive on chat and sends think: false when it is not set.
function ollamaBody(config: NodeConfig): (body: JsonBody) => void {
  return (body) => {
    if (config.keep_alive !== null) body.keep_alive = config.keep_alive
    if (config.think === null) delete body.think
  }
}

// The profile's temperature and think go into the Anthropic body as they are.
function anthropicBody(config: NodeConfig): (body: JsonBody) => void {
  return (body) => {
    if (config.temperature !== null) body.temperature = config.temperature
    if (config.think !== null) body.think = config.think
  }
}

/** Requests go to `<base>/v1/messages`, or to the base itself when it already ends with that. */
export function anthropicBaseUrl(apiBase: string): string {
  const base = apiBase.replace(/\/+$/, '')
  const messages = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`
  return messages.slice(0, -'/messages'.length)
}

function anthropicKey(settings: Settings): string | null {
  const key = settings.anthropicApiKey === null ? '' : settings.anthropicApiKey.reveal().trim()
  return key === '' ? null : key
}

function languageModel(config: NodeConfig, timeoutS: number, settings: Settings): Model {
  const timeoutMs = timeoutS * 1000
  if (isLocal(config)) {
    const ollama = createOllama({
      baseURL: `${settings.ollamaBaseUrl}/api`,
      fetch: httpClient(timeoutMs, ollamaBody(config)),
    })
    return ollama(ollamaModel(config))
  }
  const anthropic = createAnthropic({
    baseURL: anthropicBaseUrl(settings.anthropicApiBase),
    apiKey: anthropicKey(settings) ?? '',
    fetch: httpClient(timeoutMs, anthropicBody(config)),
  })
  return anthropic(config.model.slice(ANTHROPIC_PREFIX.length))
}

const MISSING_KEY = 'Anthropic API key missing: set ANTHROPIC_API_KEY'

/** What is refused before sending: a temperature the model does not accept, then a missing key. */
function cloudRefusal(config: NodeConfig, settings: Settings): string | null {
  const model = config.model.slice(ANTHROPIC_PREFIX.length)
  const temperature = config.temperature
  if (temperature !== null && temperature !== 1 && NO_SAMPLING_PARAMS.has(model)) {
    return `${model} does not accept temperature ${temperature}: only 1 is supported`
  }
  return anthropicKey(settings) === null ? MISSING_KEY : null
}

export type Parsed<T> = { success: true; data: T } | { success: false; error: string }

/** A model's text read as JSON and checked against `schema`; a failure names the first issue. */
export function parseOutput<S extends z.ZodType>(schema: S, text: string): Parsed<z.output<S>> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { success: false, error: 'invalid output: not valid JSON' }
  }
  const result = schema.safeParse(json)
  if (result.success) return { success: true, data: result.data }
  const issue = result.error.issues[0]!
  const where = issue.path.length > 0 ? ` at ${issue.path.join('.')}` : ''
  return { success: false, error: `invalid output${where}: ${issue.message}` }
}

function providerOptions(node: Node, config: NodeConfig) {
  const nodeOptions = { [NODE_OPTIONS]: { node } }
  if (!isLocal(config)) return nodeOptions
  const options: Record<string, number> = {}
  if (config.num_ctx !== null) options.num_ctx = config.num_ctx
  if (config.temperature !== null) options.temperature = config.temperature
  return {
    ...nodeOptions,
    ollama: { ...(config.think !== null && { think: config.think }), options },
  }
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started)
}

/**
 * One structured call of a node's agent, recorded in `recorder` on success and on every
 * failure the provider, the price lookup or the output's validation causes.
 */
export async function structured<S extends z.ZodType>(
  target: NodeAgent,
  messages: readonly ChatMessage[],
  schema: S,
  profile: Profile,
  recorder: RunRecorder,
  abortSignal?: AbortSignal,
): Promise<LLMResult<z.output<S>>> {
  const { node, agent } = target
  const config = profile.nodes[node]
  const requestContext = new RequestContext([
    [MODEL_KEY, languageModel(config, profile.timeout_s, getSettings())],
  ])
  const fail = (call: Omit<LLMCall, 'node' | 'model'>, cause: unknown): LLMError => {
    const recorded: LLMCall = { node, model: config.model, ...call }
    recorder.record(recorded)
    return new LLMError(`${node} (${config.model}): ${call.error}`, recorded, { cause })
  }
  const started = performance.now()
  const refusal = isLocal(config) ? null : cloudRefusal(config, getSettings())
  if (refusal !== null) {
    const call = { tokensIn: 0, tokensOut: 0, costUsd: new Decimal(0), error: refusal }
    throw fail({ ...call, latencyMs: elapsedMs(started) }, undefined)
  }
  let output
  try {
    output = await agent.generate([...messages], {
      requestContext,
      structuredOutput: { schema, errorStrategy: 'warn' },
      providerOptions: providerOptions(node, config),
      maxSteps: 1,
      abortSignal,
    })
  } catch (error) {
    abortSignal?.throwIfAborted()
    if (!AISDKError.isInstance(error)) throw error
    const zero = new Decimal(0)
    const call = { tokensIn: 0, tokensOut: 0, costUsd: zero, error: describe(error) }
    throw fail({ ...call, latencyMs: elapsedMs(started) }, error)
  }
  // An aborted generate() resolves with what it had; the caller's abort wins, unrecorded.
  abortSignal?.throwIfAborted()
  const latencyMs = elapsedMs(started)
  const tokensIn = output.usage.inputTokens ?? 0
  const tokensOut = output.usage.outputTokens ?? 0
  let costUsd = new Decimal(0)
  if (!isLocal(config)) {
    try {
      costUsd = completionCost(config.model.slice(ANTHROPIC_PREFIX.length), tokensIn, tokensOut)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const call = { tokensIn, tokensOut, latencyMs, costUsd, error: `cost lookup failed: ${text}` }
      throw fail(call, error)
    }
  }
  const validated = parseOutput(schema, output.text)
  if (!validated.success) {
    throw fail({ tokensIn, tokensOut, latencyMs, costUsd, error: validated.error }, undefined)
  }
  recorder.record({
    node,
    model: config.model,
    tokensIn,
    tokensOut,
    latencyMs,
    costUsd,
    error: null,
  })
  return { parsed: validated.data, model: config.model, tokensIn, tokensOut, latencyMs, costUsd }
}
