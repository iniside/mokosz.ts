import { randomUUID } from 'node:crypto'
import type { Mastra } from '@mastra/core'
import type { MastraMemory } from '@mastra/core/memory'
import { createStep, createWorkflow } from '@mastra/core/workflows'
import type { Lang } from '../../ingest/acts.ts'
import { citationKey } from '../../ingest/chunker.ts'
import { structured } from '../../llm/models.ts'
import { embedQuery } from '../../retrieval/embeddings.ts'
import { search } from '../../retrieval/search.ts'
import { ConversationNotFound, MEMORY, RESOURCE_ID } from '../memory.ts'
import { AnswerOutputSchema, request } from '../agents/answerer.ts'
import {
  conversation,
  HISTORY,
  resolveRefs,
  RouterOutputSchema,
  type Message,
} from '../agents/router.ts'
import {
  AnswerSchema,
  AttemptSchema,
  FiltersSchema,
  RetrievalSchema,
  RoutedSchema,
  TurnInputSchema,
  type Answer,
  type Attempt,
  type Filters,
  type Retrieved,
} from './state.ts'
import { wrap, type RunContext } from './wrap.ts'

export const MAX_ATTEMPTS = 2
export const NOT_FOUND: Record<Lang, string> = {
  en: 'Not found in the sources.',
  pl: 'Nie znaleziono w źródłach.',
}

function memoryOf(mastra: Mastra): MastraMemory {
  return mastra.getMemory(MEMORY)
}

// Memory.saveMessages trims and strips working-memory tags, and Memory.recall drops messages
// starting with <system-reminder>; the storage domain keeps the text as it was written.
async function messageStore(memory: MastraMemory) {
  const store = await memory.storage.getStore('memory')
  if (store === undefined) throw new Error('the Memory storage has no memory domain')
  return store
}

let lastCreatedAt = 0

// Messages are listed by createdAt, then by their random id: saves keep their order only if no
// two share a millisecond.
function nextCreatedAt(): Date {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)
  return new Date(lastCreatedAt)
}

type StoredMessage = Awaited<
  ReturnType<Awaited<ReturnType<typeof messageStore>>['listMessages']>
>['messages'][number]

export async function saveMessage(
  memory: MastraMemory,
  conversationId: string,
  role: Message['role'],
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const store = await messageStore(memory)
  signal?.throwIfAborted()
  await store.saveMessages({
    messages: [
      {
        id: randomUUID(),
        threadId: conversationId,
        resourceId: RESOURCE_ID,
        role,
        createdAt: nextCreatedAt(),
        content: { format: 2, parts: [{ type: 'text', text }] },
      },
    ],
  })
}

function asMessage(message: StoredMessage): Message {
  const text = message.content.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
  return { role: message.role === 'user' ? 'user' : 'assistant', text: text.join('') }
}

/** The conversation's messages in the order they were saved; the last `last` when given. */
export async function conversationMessages(
  memory: MastraMemory,
  conversationId: string,
  last?: number,
): Promise<Message[]> {
  const store = await messageStore(memory)
  const { messages } = await store.listMessages({
    threadId: conversationId,
    perPage: last ?? false,
    orderBy: { field: 'createdAt', direction: last === undefined ? 'ASC' : 'DESC' },
  })
  const ordered = last === undefined ? messages : messages.toReversed()
  return ordered.map(asMessage)
}

/** The previous turn's filters, from the thread metadata; null before the first routed turn. */
export async function previousFilters(
  memory: MastraMemory,
  conversationId: string,
  signal?: AbortSignal,
): Promise<Filters | null> {
  signal?.throwIfAborted()
  const thread = await memory.getThreadById({ threadId: conversationId })
  if (thread === null)
    throw new ConversationNotFound(`conversation ${conversationId} does not exist`)
  const filters = thread.metadata?.filters
  return filters === undefined ? null : FiltersSchema.parse(filters)
}

async function router(
  input: { conversation_id: string },
  context: RunContext,
  mastra: Mastra,
): Promise<{ conversation_id: string; query: string; filters: Filters }> {
  const { signal } = context
  const memory = memoryOf(mastra)
  const conversationId = input.conversation_id
  const previous = await previousFilters(memory, conversationId, signal)
  signal.throwIfAborted()
  const recent = await conversationMessages(memory, conversationId, HISTORY + 1)
  const messages = [{ role: 'user' as const, content: conversation(recent) }]
  const agent = { node: 'router' as const, agent: mastra.getAgent('router') }
  const result = await structured(
    agent,
    messages,
    RouterOutputSchema,
    context.profile,
    context.recorder,
    signal,
  )
  const output = result.parsed
  const acts = [...new Set(output.acts)]
  const filters: Filters = {
    lang: output.lang,
    acts,
    article_refs: resolveRefs(output.article_refs, acts, previous),
  }
  // structured() has thrown already if the run was aborted during the call.
  await memory.updateThread({ id: conversationId, metadata: { filters } })
  return { conversation_id: conversationId, query: output.query, filters }
}

async function retriever(
  input: { conversation_id: string; query: string; filters: Filters },
  context: RunContext,
): Promise<{ conversation_id: string; query: string; filters: Filters; retrieved: Retrieved[] }> {
  const { filters } = input
  const { signal } = context
  const vector = await embedQuery(input.query, { abortSignal: signal })
  signal.throwIfAborted()
  const client = await context.pool.connect()
  let chunks
  try {
    chunks = await search(client, vector, {
      lang: filters.lang,
      acts: filters.acts,
      articleRefs: filters.article_refs.map((ref) => [ref.act, ref.article] as const),
      topK: context.profile.retrieval.top_k,
      signal,
    })
  } catch (error) {
    // pg cannot cancel a statement it has sent: an aborted search's connection is discarded.
    client.release(signal.aborted)
    throw error
  }
  client.release()
  const retrieved = chunks.map((chunk) => ({
    citation_key: citationKey(chunk),
    lang: chunk.lang,
    text: chunk.text,
    heading: chunk.heading,
  }))
  return { ...input, retrieved }
}

async function answerer(input: Attempt, context: RunContext, mastra: Mastra): Promise<Attempt> {
  const messages = [{ role: 'user' as const, content: request(input) }]
  const agent = { node: 'answerer' as const, agent: mastra.getAgent('answerer') }
  const result = await structured(
    agent,
    messages,
    AnswerOutputSchema,
    context.profile,
    context.recorder,
    context.signal,
  )
  const answer: Answer = {
    lang: input.filters.lang,
    not_found: result.parsed.not_found,
    claims: result.parsed.claims.map((claim) => ({
      text: claim.text,
      citations: [...claim.citations],
    })),
  }
  return { ...input, answer, attempts: input.attempts + 1 }
}

export function verify(answer: Answer, retrievedKeys: ReadonlySet<string>): string[] {
  const reasons: string[] = []
  for (const [index, claim] of answer.claims.entries()) {
    if (claim.citations.length === 0) reasons.push(`claim ${index + 1} has no citation`)
    for (const key of new Set(claim.citations)) {
      if (!retrievedKeys.has(key)) reasons.push(`${key} was not retrieved`)
    }
  }
  if (answer.claims.length === 0 && !answer.not_found) {
    reasons.push('no claims but not_found is false')
  }
  if (answer.claims.length > 0 && answer.not_found) {
    reasons.push('claims present but not_found is true')
  }
  return reasons
}

export function reply(answer: Answer): string {
  if (answer.not_found) return NOT_FOUND[answer.lang]
  return answer.claims.map((claim) => claim.text).join(' ')
}

async function verifier(input: Attempt, context: RunContext, mastra: Mastra): Promise<Attempt> {
  const { answer } = input
  if (answer === null) throw new Error('verifier ran without an answer')
  const memory = memoryOf(mastra)
  const reasons = verify(answer, new Set(input.retrieved.map((chunk) => chunk.citation_key)))
  if (reasons.length === 0) {
    await saveMessage(memory, input.conversation_id, 'assistant', reply(answer), context.signal)
    return { ...input, verifier_errors: [] }
  }
  if (input.attempts < MAX_ATTEMPTS) return { ...input, verifier_errors: reasons }
  const notFound: Answer = { lang: answer.lang, not_found: true, claims: [] }
  await saveMessage(memory, input.conversation_id, 'assistant', reply(notFound), context.signal)
  return { ...input, answer: notFound, verifier_errors: reasons }
}

export function createQaWorkflow() {
  const routerStep = createStep({
    id: 'router',
    inputSchema: TurnInputSchema,
    outputSchema: RoutedSchema,
    execute: wrap('router', router),
  })
  const retrieverStep = createStep({
    id: 'retriever',
    inputSchema: RoutedSchema,
    outputSchema: RetrievalSchema,
    execute: wrap('retriever', retriever),
  })
  const answererStep = createStep({
    id: 'answerer',
    inputSchema: AttemptSchema,
    outputSchema: AttemptSchema,
    execute: wrap('answerer', answerer),
  })
  const verifierStep = createStep({
    id: 'verifier',
    inputSchema: AttemptSchema,
    outputSchema: AttemptSchema,
    execute: wrap('verifier', verifier),
  })
  const answerVerify = createWorkflow({
    id: 'answer-verify',
    inputSchema: AttemptSchema,
    outputSchema: AttemptSchema,
  })
    .then(answererStep)
    .then(verifierStep)
    .commit()
  return createWorkflow({
    id: 'qa',
    inputSchema: TurnInputSchema,
    outputSchema: AnswerSchema,
    options: { autoRestartActiveRuns: false },
  })
    .then(routerStep)
    .then(retrieverStep)
    .map(async ({ inputData }) => ({
      ...inputData,
      answer: null,
      attempts: 0,
      verifier_errors: [],
    }))
    .dountil(
      answerVerify,
      async ({ inputData, iterationCount }) =>
        inputData.verifier_errors.length === 0 || iterationCount >= MAX_ATTEMPTS,
    )
    .map(async ({ inputData }) => {
      if (inputData.answer === null) throw new Error('the turn ended without an answer')
      return inputData.answer
    })
    .commit()
}
