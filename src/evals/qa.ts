import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { LangSchema } from '../ingest/acts.ts'

export const EvidenceSchema = z.strictObject({
  key: z.string().min(1),
  quote: z.string().min(1),
})

export const EvalItemSchema = z
  .strictObject({
    id: z.string().min(1),
    lang: LangSchema,
    question: z.string().min(1),
    expected: z.array(z.string().min(1)),
    evidence: z.array(EvidenceSchema),
    reference: z.string().min(1),
    not_found: z.boolean(),
  })
  .check((ctx) => {
    const { expected, evidence, not_found } = ctx.value
    const issue = (message: string): void => {
      ctx.issues.push({ code: 'custom', message, input: ctx.value })
    }
    if (not_found && expected.length > 0) issue('a not_found item must have no expected keys')
    if (!not_found && expected.length === 0) issue('an answerable item needs expected keys')
    const quoted = new Set(evidence.map((entry) => entry.key))
    for (const key of expected) {
      if (!quoted.has(key)) issue(`expected key ${key} has no evidence`)
    }
    for (const key of quoted) {
      if (!expected.includes(key)) issue(`evidence key ${key} is not expected`)
    }
  })
export type EvalItem = z.infer<typeof EvalItemSchema>

export const EvalSetSchema = z.array(EvalItemSchema).check((ctx) => {
  const seen = new Set<string>()
  for (const item of ctx.value) {
    if (seen.has(item.id)) {
      ctx.issues.push({ code: 'custom', message: `duplicate id ${item.id}`, input: item.id })
    }
    seen.add(item.id)
  }
})

export class EvalSetError extends Error {
  override name = 'EvalSetError'
}

export function itemsPath(root: string): string {
  return join(root, 'evals', 'qa', 'items.json')
}

export function parseItems(input: unknown): EvalItem[] {
  const result = EvalSetSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
    )
    throw new EvalSetError(issues.join('; '))
  }
  return result.data
}

export async function loadItems(root: string): Promise<EvalItem[]> {
  const path = itemsPath(root)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new EvalSetError(`${path} does not exist`)
    }
    throw error
  }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new EvalSetError(`${path}: ${error.message}`)
    throw error
  }
  try {
    return parseItems(input)
  } catch (error) {
    if (error instanceof EvalSetError) throw new EvalSetError(`${path}: ${error.message}`)
    throw error
  }
}
