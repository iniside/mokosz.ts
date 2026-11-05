import { z } from 'zod'
import { nodeAgent, type NodeAgent } from '../../llm/models.ts'
import { load } from '../../prompts/index.ts'
import type { Attempt, Retrieved } from '../workflows/state.ts'

export const PROMPT = load('answerer')

export const AnswerClaimSchema = z.strictObject({
  text: z.string(),
  // minItems guides the model; an empty list still parses so the verifier can reject and retry.
  citations: z.array(z.string()).meta({ minItems: 1 }),
})

export const AnswerOutputSchema = z.strictObject({
  claims: z.array(AnswerClaimSchema),
  not_found: z.boolean(),
})

export function createAnswererAgent(): NodeAgent['agent'] {
  return nodeAgent('answerer', PROMPT).agent
}

function source(chunk: Retrieved): string {
  const heading = chunk.heading ? ` ${chunk.heading}` : ''
  return `[${chunk.citation_key}]${heading}\n${chunk.text}`
}

export function request(
  state: Pick<Attempt, 'filters' | 'query' | 'retrieved' | 'verifier_errors'>,
): string {
  const sources = state.retrieved.map(source).join('\n\n') || '(none)'
  const parts = [
    `Answer language: ${state.filters.lang}`,
    `Question: ${state.query}`,
    `Sources:\n${sources}`,
  ]
  if (state.verifier_errors.length > 0) {
    parts.push(`Rejected:\n${state.verifier_errors.map((error) => `- ${error}`).join('\n')}`)
  }
  return parts.join('\n\n')
}
