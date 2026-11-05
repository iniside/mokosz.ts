import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, YAMLError } from 'yaml'
import { z } from 'zod'

export const PROFILES_DIR = join(import.meta.dirname, '..', '..', 'profiles')
export const OLLAMA_PREFIX = 'ollama_chat/'
export const ANTHROPIC_PREFIX = 'anthropic/'
const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/
const UTF8 = new TextDecoder('utf-8', { fatal: true })

export const NODES = ['router', 'answerer'] as const
export type Node = (typeof NODES)[number]

export class ProfileError extends Error {
  override name = 'ProfileError'
}

export class UnknownProfile extends ProfileError {
  override name = 'UnknownProfile'
}

const NodeConfigSchema = z
  .strictObject({
    model: z.string(),
    num_ctx: z.int().gt(0).nullable().default(null),
    think: z.boolean().nullable().default(null),
    temperature: z.number().gte(0).nullable().default(null),
    keep_alive: z.string().nullable().default(null),
  })
  .superRefine((config, context) => {
    if (!config.model.startsWith(OLLAMA_PREFIX) && !config.model.startsWith(ANTHROPIC_PREFIX)) {
      context.addIssue(`model must start with ${OLLAMA_PREFIX} or ${ANTHROPIC_PREFIX}`)
    } else if (
      !config.model.startsWith(OLLAMA_PREFIX) &&
      (config.num_ctx !== null || config.keep_alive !== null)
    ) {
      context.addIssue('num_ctx and keep_alive apply to ollama_chat models only')
    }
  })
export type NodeConfig = z.output<typeof NodeConfigSchema>

const ProfileSchema = z.strictObject({
  name: z.string(),
  nodes: z.strictObject({ router: NodeConfigSchema, answerer: NodeConfigSchema }),
  retrieval: z.strictObject({ top_k: z.int().gte(1) }),
  timeout_s: z.number().gt(0),
})
export type Profile = Readonly<z.output<typeof ProfileSchema>>

export function isLocal(config: NodeConfig): boolean {
  return config.model.startsWith(OLLAMA_PREFIX)
}

export function ollamaModel(config: NodeConfig): string {
  return isLocal(config) ? config.model.slice(OLLAMA_PREFIX.length) : config.model
}

/** The Ollama models of the nodes, in node order, without repeats. */
export function ollamaModels(profile: Profile): string[] {
  const configs = [profile.nodes.router, profile.nodes.answerer]
  return [...new Set(configs.filter(isLocal).map(ollamaModel))]
}

function validationMessage(error: z.ZodError): string {
  const lines = error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  )
  return ['invalid profile', ...lines].join('\n')
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function loadProfile(
  name: string,
  directory: string = PROFILES_DIR,
): Promise<Profile> {
  const file = `${name}.yaml`
  const path = join(directory, file)
  if (!PROFILE_NAME.test(name) || !(await isFile(path))) {
    throw new UnknownProfile(`unknown profile: ${name}`)
  }
  const text = UTF8.decode(await readFile(path))
  let input: unknown
  try {
    // YAML 1.1, where a later duplicate key wins.
    input = parse(text, { version: '1.1', uniqueKeys: false }) ?? null
  } catch (error) {
    if (error instanceof YAMLError) throw new ProfileError(`${file}: ${error.message}`)
    throw error
  }
  const result = ProfileSchema.safeParse(input)
  if (!result.success) throw new ProfileError(`${file}: ${validationMessage(result.error)}`)
  const profile = result.data
  if (profile.name !== name) {
    throw new ProfileError(
      `${file}: name is ${JSON.stringify(profile.name)}, expected ${JSON.stringify(name)}`,
    )
  }
  return profile
}
