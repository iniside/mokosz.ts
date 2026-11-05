import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..', '..')

// Packages that build or call a chat model: any subpath of these counts.
const CHAT_PACKAGES = ['@ai-sdk', 'ollama-ai-provider-v2']
// Every @mastra/core subpath counts but these, which build no model.
const MASTRA_CORE = '@mastra/core'
const MASTRA_ALLOWED = [
  '@mastra/core/memory',
  '@mastra/core/request-context',
  '@mastra/core/workflows',
]
// Names of `ai` and `@mastra/core` that call or build a chat model.
const CHAT_NAMES: Record<string, string[]> = {
  ai: ['generateText', 'streamText', 'generateObject', 'streamObject', 'ToolLoopAgent', 'Agent'],
  [MASTRA_CORE]: ['Agent'],
}
// What a module loaded from a computed specifier or through createRequire is reported as.
const UNKNOWN = '<computed>'
const SOURCE = /\.(?:[cm]?ts|[cm]?js)$/

interface Imported {
  specifier: string
  names: string[] | '*'
}

const QUOTED = String.raw`(?<quote>['"\x60])([^'"\x60$]+)\k<quote>`
const STATIC = new RegExp(
  String.raw`\b(?:import|export)\s+(?:type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*${QUOTED}`,
  'g',
)
const BARE = new RegExp(String.raw`\bimport\s*${QUOTED}`, 'g')
const DYNAMIC = new RegExp(String.raw`\b(?:import|require)\s*\(\s*${QUOTED}\s*\)`, 'g')
const COMPUTED = new RegExp(String.raw`\b(?:import|require)\s*\((?!\s*${QUOTED}\s*\))`, 'g')
const CREATE_REQUIRE = /\bcreateRequire\s*\([^)]*\)/g
const REQUIRE_ALIAS = /([\w$]+)\s*=\s*(?:[\w$]+\.)?createRequire\s*\(/g

/** The source with its comments blanked; string and template literals are kept. */
function withoutComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === '"' || char === "'" || char === '`') {
      let end = index + 1
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1
      out += source.slice(index, end + 1)
      index = end + 1
    } else if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      out += ' '
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      out += ' '
    } else {
      out += char
      index++
    }
  }
  return out
}

function calls(source: string, callee: RegExp): Imported[] {
  const found: Imported[] = []
  for (const match of source.matchAll(callee)) {
    const rest = source.slice(match.index + match[0].length)
    const literal = new RegExp(String.raw`^\s*\(\s*${QUOTED}\s*\)`).exec(rest)
    found.push({ specifier: literal?.[2] ?? UNKNOWN, names: '*' })
  }
  return found
}

function requireCalls(source: string): Imported[] {
  const aliases = [...source.matchAll(REQUIRE_ALIAS)].map((match) => match[1]!)
  return [
    ...calls(source, CREATE_REQUIRE),
    ...aliases.flatMap((alias) => calls(source, new RegExp(String.raw`\b${alias}(?=\s*\()`, 'g'))),
  ]
}

function importedNames(clause: string): string[] | '*' {
  if (clause.includes('*')) return '*'
  const names: string[] = []
  const braces = /\{([^}]*)\}/.exec(clause)
  for (const part of braces?.[1]?.split(',') ?? []) {
    const name = part
      .trim()
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
    if (name) names.push(name)
  }
  if (/^\s*[\w$]+\s*(?:,|$)/.test(clause)) names.push('default')
  return names
}

function importsOf(source: string, computed: boolean): Imported[] {
  return [
    ...[...source.matchAll(STATIC)].map((m) => ({
      specifier: m[3]!,
      names: importedNames(m[1]!),
    })),
    ...[...source.matchAll(BARE)].map((m): Imported => ({ specifier: m[2]!, names: [] })),
    ...[...source.matchAll(DYNAMIC)].map((m): Imported => ({ specifier: m[2]!, names: '*' })),
    ...(computed ? [...source.matchAll(COMPUTED)] : []).map((): Imported => ({
      specifier: UNKNOWN,
      names: '*',
    })),
    ...requireCalls(source),
  ]
}

function isChatImport({ specifier, names }: Imported): boolean {
  if (specifier === UNKNOWN) return true
  if (CHAT_PACKAGES.some((p) => specifier === p || specifier.startsWith(`${p}/`))) return true
  if (specifier.startsWith(`${MASTRA_CORE}/`)) return !MASTRA_ALLOWED.includes(specifier)
  const chat = CHAT_NAMES[specifier]
  if (chat === undefined) return false
  return names === '*' || names.some((name) => chat.includes(name))
}

// Both texts are scanned: an import commented out still counts, one split by comments too; a
// computed specifier is looked for without the comments, which the call may hold.
function chatImports(source: string): string[] {
  const found = [importsOf(source, false), importsOf(withoutComments(source), true)]
    .flat()
    .filter(isChatImport)
    .map((imported) => imported.specifier)
  return [...new Set(found)].toSorted()
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('import boundary', () => {
  test.for<[string, string, string[]]>([
    [
      'dynamic',
      "export function f() {\n  return import('@ai-sdk/anthropic')\n}\n",
      ['@ai-sdk/anthropic'],
    ],
    ['require', "const p = require('ollama-ai-provider-v2')\n", ['ollama-ai-provider-v2']],
    [
      're-export',
      "export { createOllama } from 'ollama-ai-provider-v2'\n",
      ['ollama-ai-provider-v2'],
    ],
    ['export star', "export * from '@ai-sdk/openai'\n", ['@ai-sdk/openai']],
    ['type only', "import type { Agent } from '@mastra/core/agent'\n", ['@mastra/core/agent']],
    [
      'subpath',
      "import { x } from 'ollama-ai-provider-v2/internal'\n",
      ['ollama-ai-provider-v2/internal'],
    ],
    ['other provider', "import { openai } from '@ai-sdk/openai'\n", ['@ai-sdk/openai']],
    ['mastra llm', "import { MastraLLM } from '@mastra/core/llm'\n", ['@mastra/core/llm']],
    [
      'tool loop agent',
      "import { T } from '@mastra/core/tool-loop-agent'\n",
      ['@mastra/core/tool-loop-agent'],
    ],
    ['mastra root agent', "import { Mastra, Agent } from '@mastra/core'\n", ['@mastra/core']],
    ['ai call', "import {\n  embed,\n  generateText as g,\n} from 'ai'\n", ['ai']],
    ['ai stream', "import { streamText } from 'ai'\n", ['ai']],
    ['ai namespace', "import * as ai from 'ai'\n", ['ai']],
    ['ai dynamic', "const { generateObject } = await import('ai')\n", ['ai']],
    ['side effect', "import '@ai-sdk/anthropic'\n", ['@ai-sdk/anthropic']],
    ['ai errors only', "import { AISDKError, APICallError, embedMany } from 'ai'\n", []],
    ['mastra root only', "import { Mastra } from '@mastra/core'\n", []],
    [
      'look-alikes',
      "import x from 'ollama-ai-provider-v2-ish'\nimport { y } from '@ai-sdkx/z'\nimport { z } from 'ai-utils'\n",
      [],
    ],
    ['mastra storage', "import { s } from '@mastra/core/storage'\n", ['@mastra/core/storage']],
    ['mastra evals', "import * as e from '@mastra/core/evals'\n", ['@mastra/core/evals']],
    [
      'allowed mastra',
      "import { createStep } from '@mastra/core/workflows'\nimport { RequestContext } from '@mastra/core/request-context'\nimport type { MastraMemory } from '@mastra/core/memory'\n",
      [],
    ],
    ['block comment before braces', "import /* c */ { generateText } from 'ai'\n", ['ai']],
    ['line comment in braces', "import {\n  // the model\n  generateText,\n} from 'ai'\n", ['ai']],
    [
      'comment before the specifier',
      "import { Agent } from /* c */ '@mastra/core'\n",
      ['@mastra/core'],
    ],
    [
      'comment in a dynamic import',
      "await import(/* c */ '@ai-sdk/anthropic')\n",
      ['@ai-sdk/anthropic'],
    ],
    ['template dynamic', 'await import(`@ai-sdk/anthropic`)\n', ['@ai-sdk/anthropic']],
    ['interpolated template', 'await import(`@ai-sdk/${p}`)\n', ['<computed>']],
    ['computed dynamic', "const name = 'ai'\nawait import(name)\n", ['<computed>']],
    ['computed require', 'const p = require(name)\n', ['<computed>']],
    [
      'createRequire call',
      "createRequire(import.meta.url)('ollama-ai-provider-v2')\n",
      ['ollama-ai-provider-v2'],
    ],
    [
      'createRequire alias',
      "const load = createRequire(import.meta.url)\nload('ai')\n",
      ['<computed>', 'ai'],
    ],
    ['createRequire of a builtin', "createRequire(import.meta.url)('node:fs')\n", []],
    ['commented-out import', "// import { generateText } from 'ai'\n", ['ai']],
    [
      'comment marker in a string',
      "const u = 'http://x'\nimport { Agent } from '@mastra/core/agent'\n",
      ['@mastra/core/agent'],
    ],
  ])('the import scan sees a %s import', ([, source, expected]) => {
    expect(chatImports(source)).toEqual(expected)
  })

  test('the models module is the only one that builds chat models or agents', async () => {
    const src = join(ROOT, 'src')
    const importers: Record<string, string[]> = {}
    for (const file of await sourceFiles(src)) {
      const found = chatImports(await readFile(file, 'utf8'))
      if (found.length > 0) importers[relative(src, file).replaceAll('\\', '/')] = found
    }

    // Embeddings use the Ollama provider's embedding model only (step 4).
    expect(importers).toEqual({
      'llm/models.ts': ['@ai-sdk/anthropic', '@mastra/core/agent', 'ollama-ai-provider-v2'],
      'retrieval/embeddings.ts': ['ollama-ai-provider-v2'],
    })
    const embeddings = await readFile(join(src, 'retrieval', 'embeddings.ts'), 'utf8')
    expect(embeddings).not.toMatch(/ollama\.(?:chat|languageModel)\(|ollama\(/)
  })
})
