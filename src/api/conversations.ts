import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { loadProfile, UnknownProfile, type Profile } from '../llm/profiles.ts'
import { ConversationNotFound, MEMORY } from '../mastra/memory.ts'
import { createConversation, RunConflict } from '../runs/conversations.ts'
import { turns as storedTurns } from '../runs/turns.ts'
import type { AppState } from './state.ts'
import { jsonBody, parse, UuidSchema } from './validation.ts'

const TEXT = 'text must be a non-empty string'

const MessageSchema = z.strictObject(
  {
    text: z.string({ error: TEXT }).trim().min(1, TEXT),
    profile: z.string({ error: 'profile must be a string or null' }).nullable().default(null),
  },
  {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `unknown field: ${issue.keys.join(', ')}`
        : 'body must be a JSON object',
  },
)

const notFound = (c: Context): Response => c.json({ detail: 'conversation not found' }, 404)

export function conversationRoutes(state: AppState): Hono {
  const memory = state.mastra.getMemory(MEMORY)
  const routes = new Hono()

  routes.post('/conversations', async (c) => c.json({ id: await createConversation(memory) }, 201))

  routes.get('/conversations/:conversation_id', async (c) => {
    const id = parse(c, UuidSchema, c.req.param('conversation_id'))
    if (!id.ok) return id.response
    const turns = await storedTurns(state.pool, memory, id.value)
    if (turns === null) return notFound(c)
    return c.json({ id: id.value, turns })
  })

  routes.post('/conversations/:conversation_id/messages', async (c) => {
    const id = parse(c, UuidSchema, c.req.param('conversation_id'))
    if (!id.ok) return id.response
    const message = await jsonBody(c, MessageSchema)
    if (!message.ok) return message.response
    let profile: Profile
    try {
      profile = await loadProfile(message.value.profile || state.settings.defaultProfile)
    } catch (error) {
      if (error instanceof UnknownProfile) return c.json({ detail: error.message }, 404)
      throw error
    }
    let runId: string
    try {
      runId = await state.executor.start(id.value, message.value.text, profile)
    } catch (error) {
      if (error instanceof ConversationNotFound) return notFound(c)
      if (error instanceof RunConflict) {
        return c.json({ detail: 'a run is already active in this conversation' }, 409)
      }
      throw error
    }
    return c.json({ run_id: runId }, 202)
  })

  return routes
}
