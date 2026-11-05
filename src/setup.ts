import { CommandError, runCommand, type CommandResult } from './command.ts'
import { upgradeHead } from './db/index.ts'
import { seedCommand, seedDatabase } from './ingest/commands.ts'
import { ProfileError, loadProfile, ollamaModels } from './llm/profiles.ts'
import { PullError, ollamaReachable, pullModel } from './llm/pull.ts'
import { EMBEDDING_MODEL } from './retrieval/index.ts'
import type { Settings } from './settings.ts'

export interface SetupDeps {
  run: typeof runCommand
  seedDatabase: typeof seedDatabase
}

async function modelsToPull(profiles: string[]): Promise<string[]> {
  const models: string[] = []
  for (const name of profiles) {
    try {
      models.push(...ollamaModels(await loadProfile(name)))
    } catch (error) {
      if (error instanceof ProfileError) throw new CommandError(`Profile error: ${error.message}`)
      throw error
    }
  }
  return [...new Set([...models, EMBEDDING_MODEL])]
}

function failed(message: string, result: CommandResult): CommandError {
  const detail = result.stderr.trim()
  return new CommandError(detail === '' ? message : `${message}\n${detail}`)
}

async function pull(baseUrl: string, model: string): Promise<void> {
  try {
    await pullModel(baseUrl, model)
  } catch (error) {
    if (error instanceof PullError)
      throw new CommandError(`Pulling ${model} failed: ${error.message}`)
    throw error
  }
  process.stdout.write(`Pulled ${model}\n`)
}

export async function setup(
  root: string,
  settings: Settings,
  profiles: string[],
  deps: SetupDeps = { run: runCommand, seedDatabase },
): Promise<void> {
  const models = await modelsToPull(profiles.length > 0 ? profiles : [settings.defaultProfile])

  if (deps.run(['docker', 'info'], root).status !== 0) {
    throw new CommandError('Docker is not running: start the Docker daemon')
  }
  process.stdout.write('Docker: ok\n')

  if (await ollamaReachable(settings.ollamaBaseUrl)) {
    process.stdout.write(`Ollama: ok (${settings.ollamaBaseUrl})\n`)
    for (const model of models) await pull(settings.ollamaBaseUrl, model)
  } else {
    process.stdout.write(
      `Warning: Ollama is not reachable at ${settings.ollamaBaseUrl}; models not pulled\n`,
    )
  }

  const compose = deps.run(['docker', 'compose', 'up', '-d', '--wait', 'db'], root)
  if (compose.status !== 0) throw failed('Starting the database failed', compose)
  process.stdout.write('Database: up\n')

  await upgradeHead(settings.databaseUrl)
  process.stdout.write('Migrations: at head\n')

  await seedCommand(root, settings.databaseUrl, deps.seedDatabase)
}
