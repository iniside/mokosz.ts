import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'
import { upgradeHead } from '../../src/db/index.ts'
import { clearSettingsCache, getSettings } from '../../src/settings.ts'
import { createDatabase, databaseName, dropDatabase, sweepStale } from './databases.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    serverUrl: string
    testDatabaseUrl: string
    databaseRegistry: string
  }
}

const DROP = join(import.meta.dirname, 'drop-databases.ts')

function registered(registry: string): string[] {
  return existsSync(registry) ? readFileSync(registry, 'utf8').split('\n').filter(Boolean) : []
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const serverUrl = getSettings().databaseUrl
  await sweepStale(serverUrl, new Date())
  const directory = mkdtempSync(join(tmpdir(), 'mokosz-run-'))
  const registry = join(directory, 'databases.txt')
  const name = databaseName('test', new Date())
  writeFileSync(registry, `${name}\n`, 'utf8')
  const url = await createDatabase(serverUrl, name)
  try {
    await upgradeHead(url)
  } catch (error) {
    await dropDatabase(serverUrl, name)
    throw error
  }
  // Vitest exits on SIGINT without running this teardown, so the run's databases are dropped
  // synchronously before it does.
  const interrupted = (): void => {
    spawnSync(process.execPath, [DROP, serverUrl, ...registered(registry)], {
      stdio: 'inherit',
      timeout: 30_000,
    })
    rmSync(directory, { recursive: true, force: true })
  }
  process.once('SIGINT', interrupted)
  // Workers inherit the environment, so their settings point at the per-run database.
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = url
  clearSettingsCache()
  project.provide('serverUrl', serverUrl)
  project.provide('testDatabaseUrl', url)
  project.provide('databaseRegistry', registry)
  return async () => {
    process.off('SIGINT', interrupted)
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    clearSettingsCache()
    await dropDatabase(serverUrl, name)
    rmSync(directory, { recursive: true, force: true })
  }
}
