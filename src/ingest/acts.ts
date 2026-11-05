import { z } from 'zod'

export const ACTS = [
  ['32016R0679', 'GDPR'],
  ['32024R1689', 'AI Act'],
  ['32022L2555', 'NIS2'],
] as const

export const LANGUAGES = ['en', 'pl'] as const
export const LangSchema = z.enum(LANGUAGES)
export type Lang = z.infer<typeof LangSchema>
