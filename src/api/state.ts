import type { Mastra } from '@mastra/core'
import type { Pool } from 'pg'
import type { Executor } from '../runs/executor.ts'
import type { Settings } from '../settings.ts'

export type Fetch = typeof fetch

export interface AppState {
  settings: Settings
  pool: Pool
  fetch: Fetch
  mastra: Mastra
  executor: Executor
}
