import { Mastra } from '@mastra/core'
import { Memory } from '@mastra/memory'
import { PostgresStore } from '@mastra/pg'
import type { Pool } from 'pg'
import { createAnswererAgent } from './agents/answerer.ts'
import { createRouterAgent } from './agents/router.ts'
import { MEMORY } from './memory.ts'
import { createQaWorkflow } from './workflows/qa.ts'

export const STORAGE_SCHEMA = 'mastra'

// No logger: an agent logs a failed provider call with its request body, prompts included.
export function createMastra(pool: Pool) {
  const storage = new PostgresStore({ id: 'mokosz', pool, schemaName: STORAGE_SCHEMA })
  return new Mastra({
    storage,
    logger: false,
    memory: { [MEMORY]: new Memory({ storage }) },
    agents: { router: createRouterAgent(), answerer: createAnswererAgent() },
    workflows: { qa: createQaWorkflow() },
  })
}
