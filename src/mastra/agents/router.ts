import { z } from 'zod'
import { ACTS, LangSchema } from '../../ingest/acts.ts'
import { nodeAgent, type NodeAgent } from '../../llm/models.ts'
import { load } from '../../prompts/index.ts'
import type { ArticleRef, Filters } from '../workflows/state.ts'

export const HISTORY = 10
export const PROMPT = load('router')
export const ACT_NAMES: readonly string[] = ACTS.map(([, name]) => name)

const ActName = z
  .string()
  .refine((name) => ACT_NAMES.includes(name), {
    error: (issue) => `unknown act ${JSON.stringify(issue.input)}`,
  })
  .meta({ enum: [...ACT_NAMES] })

export const RouterRefSchema = z.strictObject({
  act: ActName.nullable(),
  // A model may write the article number as a digit string.
  article: z.preprocess(
    (value) => (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value),
    z.int().gte(1),
  ),
})
export type RouterRef = z.output<typeof RouterRefSchema>

export const RouterOutputSchema = z.strictObject({
  lang: LangSchema,
  acts: z.array(ActName).max(ACT_NAMES.length),
  article_refs: z.array(RouterRefSchema),
  query: z.string().trim().min(1),
})
export type RouterOutput = z.output<typeof RouterOutputSchema>

export interface Message {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export function createRouterAgent(): NodeAgent['agent'] {
  return nodeAgent('router', PROMPT).agent
}

export function conversationAct(previous: Filters | null): string | null {
  if (previous === null) return null
  const acts = new Set([...previous.acts, ...previous.article_refs.map((ref) => ref.act)])
  return acts.size === 1 ? [...acts][0]! : null
}

export function resolveRefs(
  refs: readonly RouterRef[],
  acts: readonly string[],
  previous: Filters | null,
): ArticleRef[] {
  const fromConversation = conversationAct(previous)
  const single = acts.length === 1 ? acts[0]! : null
  const resolved: ArticleRef[] = []
  for (const ref of refs) {
    const act = ref.act || fromConversation || single
    if (act === null) continue
    const item = { act, article: ref.article }
    if (!resolved.some((seen) => seen.act === item.act && seen.article === item.article)) {
      resolved.push(item)
    }
  }
  return resolved
}

function speaker(message: Message): string {
  return message.role === 'user' ? 'User' : 'Assistant'
}

/** The router's request: the last HISTORY messages before the new one, then the new one. */
export function conversation(messages: readonly Message[]): string {
  const history = messages.slice(0, -1)
  const latest = messages.at(-1)
  if (latest === undefined) throw new Error('the conversation has no messages')
  const earlier =
    history
      .slice(-HISTORY)
      .map((message) => `${speaker(message)}: ${message.text}`)
      .join('\n') || '(none)'
  return `Conversation so far:\n${earlier}\n\nNew message:\n${latest.text}`
}
