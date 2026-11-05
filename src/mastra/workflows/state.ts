import { z } from 'zod'
import { LangSchema } from '../../ingest/acts.ts'

export const ArticleRefSchema = z.strictObject({ act: z.string(), article: z.int() })
export type ArticleRef = z.infer<typeof ArticleRefSchema>

export const FiltersSchema = z.strictObject({
  lang: LangSchema,
  acts: z.array(z.string()),
  article_refs: z.array(ArticleRefSchema),
})
export type Filters = z.infer<typeof FiltersSchema>

export const RetrievedSchema = z.strictObject({
  citation_key: z.string(),
  lang: LangSchema,
  text: z.string(),
  heading: z.string().nullable(),
})
export type Retrieved = z.infer<typeof RetrievedSchema>

export const ClaimSchema = z.strictObject({ text: z.string(), citations: z.array(z.string()) })
export type Claim = z.infer<typeof ClaimSchema>

export const AnswerSchema = z.strictObject({
  lang: LangSchema,
  not_found: z.boolean(),
  claims: z.array(ClaimSchema),
})
export type Answer = z.infer<typeof AnswerSchema>

export const TurnInputSchema = z.strictObject({ conversation_id: z.string() })

export const RoutedSchema = z.strictObject({
  conversation_id: z.string(),
  query: z.string(),
  filters: FiltersSchema,
})

export const RetrievalSchema = RoutedSchema.extend({ retrieved: z.array(RetrievedSchema) })

/** What the answer-verify loop passes from one iteration to the next. */
export const AttemptSchema = RetrievalSchema.extend({
  answer: AnswerSchema.nullable(),
  attempts: z.int(),
  verifier_errors: z.array(z.string()),
})
export type Attempt = z.infer<typeof AttemptSchema>
