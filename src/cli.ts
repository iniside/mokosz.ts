#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander'
import { runServer, type ServeOptions } from './api/server.ts'
import { CommandError, repoRoot } from './command.ts'
import { evalCommand, type EvalCommandOptions } from './evals/run.ts'
import { embedCommand, fetchCommand, seedCommand } from './ingest/commands.ts'
import type { ScreenshotsOptions } from './screenshots.ts'
import { getSettings } from './settings.ts'
import { setup } from './setup.ts'

export const GIF_QUESTION =
  'Which obligations does the AI Act place on deployers of high-risk AI systems?'
// Open SSE streams would otherwise hold Ctrl+C until their runs end.
export const GRACEFUL_SHUTDOWN_MS = 5000

const SCRIPT = fileURLToPath(import.meta.url)

export interface GenerateOptions {
  out?: string
  seed?: number
}

/** What each command runs once its options are parsed; tests replace single entries. */
export interface Commands {
  serve(options: ServeOptions): Promise<number>
  setup(profiles: string[]): Promise<void>
  fetch(force: boolean): Promise<void>
  embed(models: string[]): Promise<void>
  seed(): Promise<void>
  generateInvoices(options: GenerateOptions): Promise<void>
  screenshots(options: ScreenshotsOptions): Promise<void>
  evaluate(options: EvalCommandOptions): Promise<void>
}

/** Imports a module that needs the dev dependencies, or fails with how to install them. */
export async function devModule<T>(load: () => Promise<T>, hint: string): Promise<T> {
  try {
    return await load()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new CommandError(hint)
    }
    throw error
  }
}

const COMMANDS: Commands = {
  serve: (options) => runServer(SCRIPT, options),
  setup: async (profiles) => setup(repoRoot('setup'), getSettings(), profiles),
  fetch: async (force) => fetchCommand(repoRoot('fetch'), force),
  embed: async (models) => embedCommand(repoRoot('embed'), getSettings().ollamaBaseUrl, models),
  seed: async () => seedCommand(repoRoot('seed'), getSettings().databaseUrl),
  generateInvoices: async ({ out, seed }) => {
    const { generateInvoices } = await devModule(
      () => import('./invoices/generator.ts'),
      'Generating invoices needs the dev dependencies: run npm install',
    )
    await generateInvoices(out ?? join(repoRoot('generate-invoices'), 'data', 'invoices'), seed)
  },
  screenshots: async (options) => {
    const { screenshotsCommand } = await devModule(
      () => import('./screenshots.ts'),
      'Screenshots need the dev dependencies: run npm install, then npx playwright install chromium',
    )
    await screenshotsCommand(repoRoot('screenshots'), getSettings().databaseUrl, options)
  },
  evaluate: async (options) => evalCommand(repoRoot('eval'), getSettings(), options),
}

function integer(value: string): number {
  if (!/^[+-]?\d+$/.test(value)) throw new InvalidArgumentError('Not an integer.')
  return Number(value)
}

function atLeastOne(value: string): number {
  const parsed = integer(value)
  if (parsed < 1) throw new InvalidArgumentError('Must be 1 or more.')
  return parsed
}

const collect = (value: string, previous: string[]): string[] => [...previous, value]

async function reported(body: () => Promise<number | void>): Promise<number> {
  try {
    return (await body()) ?? 0
  } catch (error) {
    if (!(error instanceof CommandError)) throw error
    process.stderr.write(`${error.message}\n`)
    return 1
  }
}

function program(commands: Commands, exited: (code: number) => void): Command {
  const mokosz = new Command('mokosz').exitOverride()
  const act = async (body: () => Promise<number | void>): Promise<void> => {
    exited(await reported(body))
  }

  mokosz
    .command('serve')
    .description('Run the API.')
    .option('--host <host>', '', '127.0.0.1')
    .option('--port <port>', '', integer, 8000)
    .option('--reload', '', false)
    .option('--no-reload', '')
    .action((options: { host: string; port: number; reload: boolean }) =>
      act(() => commands.serve({ ...options, timeoutGracefulShutdownMs: GRACEFUL_SHUTDOWN_MS })),
    )
  mokosz
    .command('setup')
    .description(
      'Check Docker and Ollama, pull the models, migrate and seed the database, enable the hook.',
    )
    .option(
      '--profile <profile>',
      'Profile whose Ollama models to pull; repeat for several.',
      collect,
      [],
    )
    .action((options: { profile: string[] }) => act(() => commands.setup(options.profile)))
  mokosz
    .command('fetch')
    .description('Download the regulations from Cellar into data/raw/.')
    .option('--force', 'Download again.', false)
    .action((options: { force: boolean }) => act(() => commands.fetch(options.force)))
  mokosz
    .command('embed')
    .description('Embed the chunks and eval queries into data/embeddings/ and print recall@5.')
    .option('--model <model>', 'Ollama embedding model; repeat to compare.', collect, [])
    .action((options: { model: string[] }) => act(() => commands.embed(options.model)))
  mokosz
    .command('seed')
    .description('Load the chunks and their committed embeddings into Postgres.')
    .action(() => act(() => commands.seed()))
  mokosz
    .command('generate-invoices')
    .description(
      'Generate the fictional invoice set (PDF and ground-truth JSON) into data/invoices/.',
    )
    .option('--out <out>', 'Output directory; default data/invoices/ in the repository.', (out) =>
      resolve(out),
    )
    .option('--seed <seed>', 'Random seed; the default reproduces the committed set.', integer)
    .action((options: GenerateOptions) => act(() => commands.generateInvoices(options)))
  mokosz
    .command('screenshots')
    .description('Capture docs/img/chat.png and docs/img/chat.gif from the running API and UI.')
    .option('--url <url>', 'The built UI served by vite preview.', 'http://localhost:4173')
    .option(
      '--conversation <conversation>',
      'Conversation for chat.png; default the latest with an answer.',
    )
    .option('--question <question>', 'Question asked through the UI for chat.gif.', GIF_QUESTION)
    .action((options: ScreenshotsOptions) => act(() => commands.screenshots(options)))
  mokosz
    .command('eval')
    .description('Run the Q&A eval set and write the results to evals/results/.')
    .option('--profile <profile>', 'Profile to evaluate; default the settings default profile.')
    .addOption(new Option('--set <set>', 'Eval set.').choices(['qa']).default('qa'))
    .option('--repeat <repeat>', 'Turns per item.', atLeastOne, 1)
    .action((options: EvalCommandOptions) => act(() => commands.evaluate(options)))
  return mokosz
}

/** Runs the CLI and returns the exit code: 0, 1 for a failed command or a usage error, or serve's. */
export async function main(argv: string[], overrides: Partial<Commands> = {}): Promise<number> {
  let code = 0
  const cli = program({ ...COMMANDS, ...overrides }, (exitCode) => {
    code = exitCode
  })
  try {
    await cli.parseAsync(argv, { from: 'user' })
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode
    throw error
  }
  return code
}

function isMain(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && existsSync(entry) && realpathSync(entry) === realpathSync(SCRIPT)
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2))
}
