import type { Context } from 'hono'
import { z } from 'zod'

export const UuidSchema = z.uuid({ error: 'Invalid UUID' }).transform((id) => id.toLowerCase())

export const SeqSchema = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number)
  .default(0)

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response }

function invalid(c: Context, message: string): Response {
  return c.json({ detail: message }, 422)
}

export function parse<S extends z.ZodType>(
  c: Context,
  schema: S,
  input: unknown,
  name?: string,
): Parsed<z.output<S>> {
  const result = schema.safeParse(input)
  if (result.success) return { ok: true, value: result.data }
  const message = result.error.issues[0]?.message ?? 'Invalid input'
  return { ok: false, response: invalid(c, name === undefined ? message : `${name} ${message}`) }
}

const JSON_TYPE = /^application\/(?:[\w.-]+\+)?json(?:\s*;.*)?$/i

// The JSON content type is required so a cross-site form post (no preflight) is refused.
export async function jsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<Parsed<z.output<S>>> {
  if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) {
    return { ok: false, response: invalid(c, 'Content-Type must be application/json') }
  }
  let body: unknown
  try {
    body = await c.req.json()
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, response: invalid(c, 'Invalid JSON') }
    throw error
  }
  return parse(c, schema, body)
}
