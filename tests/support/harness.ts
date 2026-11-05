import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { inject, test as base } from 'vitest'
import { seedChunks } from '../../src/ingest/seed.ts'
import { clearSettingsCache, getSettings, type Settings } from '../../src/settings.ts'
import { createDatabase, databaseName, dropDatabase } from './databases.ts'
import { spyOnSockets, useUnreachableOllama, type SocketPeers } from './network.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const test = base
  .extend('serverUrl', { scope: 'worker' }, (): string => inject('serverUrl'))
  .extend('testSettings', (): Settings => {
    clearSettingsCache()
    const settings = getSettings()
    if (settings.databaseUrl !== inject('testDatabaseUrl')) {
      throw new Error(`settings point at ${settings.databaseUrl}, not the per-run database`)
    }
    return settings
  })
  .extend('seededDatabaseUrl', { scope: 'worker' }, async (): Promise<string> => {
    const url = inject('testDatabaseUrl')
    const client = new Client({ connectionString: url })
    await client.connect()
    try {
      await seedChunks(client, ROOT)
    } finally {
      await client.end()
    }
    return url
  })
  .extend('throwawayDatabaseUrl', async ({ serverUrl }, { onCleanup }): Promise<string> => {
    const name = databaseName('throwaway', new Date())
    // Registered first, so an interrupted run drops it even if this worker never cleans up.
    appendFileSync(inject('databaseRegistry'), `${name}\n`, 'utf8')
    const url = await createDatabase(serverUrl, name)
    onCleanup(() => dropDatabase(serverUrl, name))
    return url
  })
  .extend('socketPeers', ({}, { onCleanup }): SocketPeers => {
    const spy = spyOnSockets()
    onCleanup(() => spy.restore())
    return spy.peers
  })
  .extend('unreachableOllama', async ({}, { onCleanup }): Promise<void> => {
    onCleanup(await useUnreachableOllama())
  })

export { describe, expect } from 'vitest'
