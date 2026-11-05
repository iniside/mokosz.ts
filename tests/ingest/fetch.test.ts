import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fetch as undiciFetch } from 'undici'
import { afterEach, beforeEach, vi } from 'vitest'
import { main } from '../../src/cli.ts'
import { fetchCommand } from '../../src/ingest/commands.ts'
import { ACTS } from '../../src/ingest/acts.ts'
import {
  CELLAR_URL,
  FetchError,
  fetchActs,
  type FetchInit,
  type FetchOptions,
  type Fetcher,
} from '../../src/ingest/fetch.ts'
import { portOf } from '../support/network.ts'
import { describe, expect, test } from '../support/harness.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

const agents = vi.hoisted(() => ({
  made: [] as { options: unknown; closed: () => boolean }[],
}))

vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>()
  class RecordingAgent extends original.Agent {
    constructor(options?: ConstructorParameters<typeof original.Agent>[0]) {
      super(options)
      agents.made.push({ options, closed: () => Reflect.get(this, 'closed') === true })
    }
  }
  return { ...original, Agent: RecordingAgent }
})

const ROOT = resolve(import.meta.dirname, '..', '..')
const XHTML = 'application/xhtml+xml;charset=UTF-8'
const CELEXES = ACTS.map(([celex]) => celex)
const LANGS = ['en', 'pl'] as const
const LANG_HEADER = { en: 'eng', pl: 'pol' }
const text = (value: string): Uint8Array => new TextEncoder().encode(value)

interface Sent {
  url: string
  celex: string
  accept: string | null
  acceptLanguage: string | null
  init: FetchInit
}

interface CellarOptions {
  status?: number
  contentType?: string
  body?: Uint8Array
  bad?: [string, string]
}

class Cellar {
  readonly requests: Sent[] = []
  readonly #options: CellarOptions

  constructor(options: CellarOptions = {}) {
    this.#options = options
  }

  fetch: Fetcher = async (url, init) => {
    const headers = new Headers(init.headers)
    const celex = url.slice(url.lastIndexOf('/') + 1)
    const acceptLanguage = headers.get('accept-language')
    this.requests.push({ url, celex, accept: headers.get('accept'), acceptLanguage, init })
    const { status = 200, contentType = XHTML, body, bad } = this.#options
    if (bad !== undefined && (bad[0] !== celex || bad[1] !== acceptLanguage)) {
      return new Response('<html/>', { status: 200, headers: { 'content-type': XHTML } })
    }
    return new Response(body ?? text(`${celex}|${acceptLanguage}`), {
      status,
      headers: { 'content-type': contentType },
    })
  }

  options(): FetchOptions {
    return { fetch: this.fetch }
  }
}

const noContentType: Fetcher = async () => new Response(new Uint8Array([1]), { status: 200 })

const refuse: Fetcher = async () => {
  throw new TypeError('no route')
}

const refuseWithCause: Fetcher = async () => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') })
}

const broken: Fetcher = async () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'))
      },
    }),
    { status: 200, headers: { 'content-type': XHTML } },
  )

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    if (error instanceof FetchError) return error.message
    throw error
  }
  throw new Error('expected a FetchError')
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mokosz-fetch-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const names = async (path: string = dir): Promise<string[]> => (await readdir(path)).toSorted()
const distinctContents = async (path: string = dir): Promise<string[]> => [
  ...new Set(
    await Promise.all(
      (await names(path)).map(async (name) => (await readFile(join(path, name))).toString()),
    ),
  ),
]

describe('fetchActs', () => {
  test('writes six files with the body bytes unchanged', async () => {
    await fetchActs(dir, new Cellar().options())

    for (const celex of CELEXES) {
      for (const lang of LANGS) {
        expect((await readFile(join(dir, `${celex}.${lang}.xhtml`))).toString()).toBe(
          `${celex}|${LANG_HEADER[lang]}`,
        )
      }
    }
    expect(await names()).toHaveLength(6)
  })

  test('sends the Cellar URL and the headers per language', async () => {
    const cellar = new Cellar()

    await fetchActs(dir, cellar.options())

    const sent = cellar.requests.map((r) => `${r.url}|${r.acceptLanguage}|${r.accept}`)
    expect(CELLAR_URL.startsWith('https://')).toBe(true)
    expect(sent.toSorted()).toEqual(
      CELEXES.flatMap((c) =>
        ['eng', 'pol'].map(
          (h) => `https://publications.europa.eu/resource/celex/${c}|${h}|application/xhtml+xml`,
        ),
      ).toSorted(),
    )
  })

  test('skips existing files without requests', async () => {
    await fetchActs(dir, new Cellar().options())
    const again = new Cellar({ body: text('new') })
    const messages: string[] = []

    await fetchActs(dir, { ...again.options(), report: (m) => messages.push(m) })

    expect(again.requests).toEqual([])
    expect(messages).toEqual(
      CELEXES.flatMap((c) => LANGS.map((lang) => `skipped ${c}.${lang}.xhtml`)),
    )
    expect((await readFile(join(dir, `${CELEXES[0]}.en.xhtml`))).toString()).toBe(
      `${CELEXES[0]}|eng`,
    )
  })

  test('fills only the missing file', async () => {
    await fetchActs(dir, new Cellar().options())
    const missing = join(dir, `${CELEXES[1]}.pl.xhtml`)
    await rm(missing)
    const again = new Cellar({ body: text('fresh') })

    await fetchActs(dir, again.options())

    expect(again.requests).toHaveLength(1)
    expect((await readFile(missing)).toString()).toBe('fresh')
  })

  test('force overwrites', async () => {
    await fetchActs(dir, new Cellar().options())
    const again = new Cellar({ body: text('forced') })

    await fetchActs(dir, { ...again.options(), force: true })

    expect(again.requests).toHaveLength(6)
    expect(await distinctContents()).toEqual(['forced'])
  })

  test('creates the directory', async () => {
    const nested = join(dir, 'data', 'raw')

    await fetchActs(nested, new Cellar().options())

    expect(await names(nested)).toHaveLength(6)
  })

  test.for<[string, CellarOptions, string]>([
    ['status 202 with an empty body', { status: 202, body: new Uint8Array() }, 'HTTP 202'],
    ['status 404', { status: 404 }, 'HTTP 404'],
    ['an empty body', { body: new Uint8Array() }, 'empty response body'],
    ['text/html', { contentType: 'text/html' }, 'got text/html'],
    ['multipart/mixed', { contentType: 'multipart/mixed; boundary=x' }, 'got multipart/mixed'],
  ])(
    'a bad response (%s) fails naming act and language and leaves no file',
    async ([, options, reason]) => {
      const message = await failure(fetchActs(dir, new Cellar(options).options()))

      expect(message).toContain('GDPR (32016R0679) en')
      expect(message).toContain(reason)
      expect(await names()).toEqual([])
    },
  )

  test('a missing content type is reported as such', async () => {
    const message = await failure(fetchActs(dir, { fetch: noContentType }))

    expect(message).toBe(
      `GDPR (32016R0679) en: expected application/xhtml+xml, got no content type`,
    )
  })

  test('a failure in the middle keeps finished files and no partial one', async () => {
    const cellar = new Cellar({ status: 404, bad: ['32024R1689', 'pol'] })

    const message = await failure(fetchActs(dir, cellar.options()))

    expect(message).toContain('AI Act (32024R1689) pl')
    expect(await names()).toEqual([
      '32016R0679.en.xhtml',
      '32016R0679.pl.xhtml',
      '32024R1689.en.xhtml',
    ])
  })

  test('a transport error is a FetchError', async () => {
    const message = await failure(fetchActs(dir, { fetch: refuse }))

    expect(message).toBe('GDPR (32016R0679) en: request failed: no route')
  })

  test('the cause of a transport error is named', async () => {
    const message = await failure(fetchActs(dir, { fetch: refuseWithCause }))

    expect(message).toBe('GDPR (32016R0679) en: request failed: fetch failed: connect ECONNREFUSED')
  })

  test('a body that fails while it is read is a FetchError', async () => {
    const message = await failure(fetchActs(dir, { fetch: broken }))

    expect(message).toContain('GDPR (32016R0679) en: request failed:')
    expect(await names()).toEqual([])
  })

  test('without an injected fetch it uses the real HTTP client', async () => {
    await onlyFirstMissing()

    const message = await failure(fetchActs(dir))

    expect(message).toBe(
      'GDPR (32016R0679) en: request failed: fetch failed: network access in tests: publications.europa.eu',
    )
  })

  test('one Agent per call carries the 60 s limits and is closed afterwards', async () => {
    agents.made.length = 0

    await fetchActs(dir, new Cellar().options())

    expect(agents.made.map((agent) => [agent.options, agent.closed()])).toEqual([
      [{ connectTimeout: 60_000, headersTimeout: 60_000, bodyTimeout: 60_000 }, true],
    ])
  })

  test('the Agent is closed when a download fails', async () => {
    agents.made.length = 0

    await failure(fetchActs(dir, new Cellar({ status: 404 }).options()))

    expect(agents.made.map((agent) => agent.closed())).toEqual([true])
  })

  test('the same Agent is passed to every request', async () => {
    const cellar = new Cellar()

    await fetchActs(dir, cellar.options())

    expect(new Set(cellar.requests.map((r) => r.init.dispatcher)).size).toBe(1)
    expect(cellar.requests.map((r) => r.init.redirect)).toEqual(Array(6).fill('follow'))
  })

  test('the media type is compared case-insensitively', async () => {
    const cellar = new Cellar({ contentType: 'Application/XHTML+XML; charset=utf-8' })

    await fetchActs(dir, cellar.options())

    expect(await names()).toHaveLength(6)
  })

  test('the body is written byte for byte', async () => {
    const body = Uint8Array.from([
      0xef, 0xbb, 0xbf, 0x20, 0x20, 0x3c, 0x70, 0x3e, 0xc5, 0xbc, 0xc3, 0xb3, 0xc5, 0x82, 0x77,
      0x0d, 0x0a, 0x0a, 0x3c, 0x2f, 0x70, 0x3e, 0x20,
    ])

    await fetchActs(dir, new Cellar({ body }).options())

    expect(await names()).toHaveLength(6)
    for (const name of await names()) {
      expect(await readFile(join(dir, name))).toEqual(Buffer.from(body))
    }
  })

  test('a failed replace keeps the old file and leaves no temp', async () => {
    const target = join(dir, `${CELEXES[0]}.en.xhtml`)
    await writeFile(target, 'old')
    vi.mocked(fsPromises.rename).mockRejectedValueOnce(new Error('disk'))

    await expect(
      fetchActs(dir, { ...new Cellar({ body: text('new') }).options(), force: true }),
    ).rejects.toThrow('disk')

    expect((await readFile(target)).toString()).toBe('old')
    expect(await names()).toEqual([`${CELEXES[0]}.en.xhtml`])
  })
})

function captured(): { out: () => string; err: () => string; restore: () => void } {
  let out = ''
  let err = ''
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk)
    return true
  })
  return {
    out: () => out,
    err: () => err,
    restore: () => {
      o.mockRestore()
      e.mockRestore()
    },
  }
}

async function runCli(
  root: string,
  cellar: Cellar,
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const output = captured()
  try {
    const code = await main(['fetch', ...args], {
      fetch: (force) => fetchCommand(root, force, cellar.options()),
    })
    return { code, out: output.out(), err: output.err() }
  } finally {
    output.restore()
  }
}

// undici fires its timers on a coarse clock, so the limits here are a second or more.
const first = (): string => join(dir, `${CELEXES[0]}.en.xhtml`)
const onlyFirstMissing = async (): Promise<void> => {
  for (const [celex] of ACTS) {
    for (const lang of LANGS) {
      if (celex !== CELEXES[0] || lang !== 'en') {
        await writeFile(join(dir, `${celex}.${lang}.xhtml`), 'kept')
      }
    }
  }
}

interface Local {
  port: number
  hits: { path: string; headers: IncomingMessage['headers'] }[]
  close: () => Promise<void>
}

async function listen(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    port: number,
  ) => void | Promise<void>,
): Promise<Local> {
  const hits: Local['hits'] = []
  const server: Server = createServer((request, response) => {
    hits.push({ path: request.url ?? '', headers: request.headers })
    void handler(request, response, portOf(server))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: portOf(server),
    hits,
    close: async () => {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
    },
  }
}

const viaLocal =
  (port: number, scheme = 'http'): Fetcher =>
  (url, init) =>
    undiciFetch(
      url.replace('https://publications.europa.eu', `${scheme}://127.0.0.1:${port}`),
      init,
    )

// Accepts TCP connections and never answers, so a TLS handshake never completes.
async function silent(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createNetServer((socket) => {
    sockets.add(socket)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: portOf(server),
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((done) => server.close(done))
    },
  }
}

function codes(error: unknown): string[] {
  const found: string[] = []
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') found.push(current.code)
  }
  return found
}

const STEADY = { 'content-type': XHTML }
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

describe('fetchActs against a local server', () => {
  let local: Local | undefined

  afterEach(async () => {
    await local?.close()
    local = undefined
  })

  test('a redirect is followed with the request headers kept', async () => {
    local = await listen((request, response, port) => {
      if (request.url === '/doc') {
        response.writeHead(200, STEADY).end('<doc/>')
      } else {
        response.writeHead(303, { location: `http://127.0.0.1:${port}/doc` }).end()
      }
    })

    await fetchActs(dir, { fetch: viaLocal(local.port) })

    const docs = local.hits.filter((hit) => hit.path === '/doc')
    expect(docs).toHaveLength(6)
    expect(
      docs.map((hit) => `${hit.headers.accept}|${hit.headers['accept-language']}`).toSorted(),
    ).toEqual(
      ['eng', 'eng', 'eng', 'pol', 'pol', 'pol'].map((lang) => `application/xhtml+xml|${lang}`),
    )
    expect(await distinctContents()).toEqual(['<doc/>'])
    expect(await names()).toHaveLength(6)
  })

  test('endless redirects fail as a request error', async () => {
    local = await listen((_, response, port) => {
      response.writeHead(302, { location: `http://127.0.0.1:${port}/again` }).end()
    })

    const message = await failure(fetchActs(dir, { fetch: viaLocal(local.port) }))

    expect(message).toContain('GDPR (32016R0679) en: request failed:')
    expect(local.hits).toHaveLength(21)
    expect(await names()).toEqual([])
  })

  test('a slow but steady body passes although it takes longer than the limit', async () => {
    local = await listen(async (_, response) => {
      response.writeHead(200, STEADY)
      for (const part of ['<a>', '<b/>', '<c/>', '</a>']) {
        response.write(part)
        await sleep(600)
      }
      response.end()
    })
    await onlyFirstMissing()
    const started = performance.now()

    await fetchActs(dir, { fetch: viaLocal(local.port), timeoutMs: 1000, force: false })

    expect(performance.now() - started).toBeGreaterThan(2000)
    expect((await readFile(first())).toString()).toBe('<a><b/><c/></a>')
  })

  test('an idle gap in the body longer than the limit fails as timed out', async () => {
    local = await listen(async (_, response) => {
      response.writeHead(200, STEADY)
      response.write('<a>')
      await sleep(5000)
      response.end('</a>')
    })
    await onlyFirstMissing()

    const message = await failure(fetchActs(dir, { fetch: viaLocal(local.port), timeoutMs: 1000 }))

    expect(message).toBe('GDPR (32016R0679) en: request failed: timed out')
    expect(await readdir(dir)).not.toContain(`${CELEXES[0]}.en.xhtml`)
  })

  test('headers later than the limit fail as timed out', async () => {
    local = await listen(async (_, response) => {
      await sleep(5000)
      response.writeHead(200, STEADY).end('<a/>')
    })
    await onlyFirstMissing()

    const message = await failure(fetchActs(dir, { fetch: viaLocal(local.port), timeoutMs: 1000 }))

    expect(message).toBe('GDPR (32016R0679) en: request failed: timed out')
  })

  test('a TLS handshake that never completes fails as timed out at the connect limit', async () => {
    const server = await silent()
    await onlyFirstMissing()
    try {
      const started = performance.now()
      const error = await fetchActs(dir, {
        fetch: viaLocal(server.port, 'https'),
        timeoutMs: 1000,
      }).catch((thrown: unknown) => thrown)

      expect(error).toBeInstanceOf(FetchError)
      expect(error instanceof FetchError && error.message).toBe(
        'GDPR (32016R0679) en: request failed: timed out',
      )
      expect(codes(error)).toContain('UND_ERR_CONNECT_TIMEOUT')
      expect(performance.now() - started).toBeLessThan(10_000)
    } finally {
      await server.close()
    }
  })

  test('headers within the configured limit pass', async () => {
    local = await listen(async (_, response) => {
      await sleep(200)
      response.writeHead(200, STEADY).end('<a/>')
    })
    await onlyFirstMissing()

    await fetchActs(dir, { fetch: viaLocal(local.port), timeoutMs: 3000 })

    expect((await readFile(first())).toString()).toBe('<a/>')
  })
})

describe('mokosz fetch', () => {
  test('writes into data/raw of the repository root', async () => {
    const result = await runCli(dir, new Cellar())

    expect(result.code).toBe(0)
    expect(await names(join(dir, 'data', 'raw'))).toHaveLength(6)
    expect(result.out).toContain('fetched 32016R0679.en.xhtml (14 bytes)\n')
  })

  test('--force overwrites', async () => {
    await runCli(dir, new Cellar())

    const result = await runCli(dir, new Cellar({ body: text('forced') }), '--force')

    expect(result.code).toBe(0)
    expect(await distinctContents(join(dir, 'data', 'raw'))).toEqual(['forced'])
  })

  test('skipped files are reported on stdout', async () => {
    await runCli(dir, new Cellar())

    const result = await runCli(dir, new Cellar())

    expect(result.out).toBe(
      CELEXES.flatMap((c) => LANGS.map((lang) => `skipped ${c}.${lang}.xhtml\n`)).join(''),
    )
    expect(result.err).toBe('')
  })

  test.for<[string, CellarOptions]>([
    ['202 with no body', { status: 202, body: new Uint8Array() }],
    ['404', { status: 404 }],
    ['text/html', { contentType: 'text/html' }],
  ])('a bad response (%s) exits 1 and leaves no file', async ([, options]) => {
    const result = await runCli(dir, new Cellar(options))

    expect(result.code).toBe(1)
    expect(result.err).toContain('Fetch failed: GDPR (32016R0679) en')
    expect(await names(join(dir, 'data', 'raw'))).toEqual([])
  })

  test('an error that is not a FetchError propagates', async () => {
    const file = join(dir, 'not-a-directory')
    await writeFile(file, '')

    await expect(fetchCommand(file, false, new Cellar().options())).rejects.toHaveProperty('code')
  })
})

describe('data/raw', () => {
  test('.gitattributes keep the raw bytes and mark embeddings binary', () => {
    const raw = 'data/raw/32016R0679.en.xhtml'
    const npy = 'data/embeddings/x/chunks.npy'
    const out = spawnSync(
      'git',
      ['check-attr', 'text', 'linguist-generated', 'binary', '--', raw, npy],
      { cwd: ROOT, encoding: 'utf8' },
    ).stdout
    const attrs = new Map<string, string>()
    for (const line of out.split('\n').filter((l) => l !== '')) {
      const [path, attr, value] = line.split(': ')
      attrs.set(`${path}|${attr}`, value!)
    }

    expect(attrs.get(`${raw}|text`)).toBe('unset')
    expect(attrs.get(`${raw}|linguist-generated`)).toBe('true')
    expect(attrs.get(`${npy}|binary`)).toBe('set')
  })

  // sha256 of the committed data/raw files, the texts the committed embeddings were made from.
  const SHA256: Record<string, string> = {
    '32016R0679.en.xhtml': '962539af03738bf552319ff4ce42d69e5f95a576307c4dfed7bf87e81b646b9d',
    '32016R0679.pl.xhtml': '4b44ea95933447cc42eb0c0bae62d27bda5855732ee929692b2e241775c78b2d',
    '32022L2555.en.xhtml': '6ee66d5c419d9a056fb98d94083cacf9b818803bd6b416435718e0d4919cb589',
    '32022L2555.pl.xhtml': '7fd741c8309df320be28a958a71acee3a30d2c1639b3ccfbacac6024d32ee61c',
    '32024R1689.en.xhtml': '8f0b656302f9864cc87e040c371f209a9d65ae1a6cecc25ca5eb737e872d721a',
    '32024R1689.pl.xhtml': '37b91c6f5fdc6c2286285af5c87c8473496685ace62b9c9c3c5afc5a0b257360',
  }

  test('the directory holds exactly the six files', async () => {
    expect(await names(join(ROOT, 'data', 'raw'))).toEqual(Object.keys(SHA256).toSorted())
  })

  test.for(CELEXES.flatMap((c) => LANGS.map((lang) => `${c}.${lang}.xhtml`)))(
    'committed %s has its pinned sha256 and is an XHTML document with article one',
    async (name) => {
      const data = await readFile(join(ROOT, 'data', 'raw', name))

      expect(createHash('sha256').update(data).digest('hex')).toBe(SHA256[name])
      expect(data.includes('<html xmlns="http://www.w3.org/1999/xhtml"')).toBe(true)
      expect(data.includes('id="art_1"')).toBe(true)
      expect(data.toString().split('<html')).toHaveLength(2)
      expect(data.toString().trimEnd().endsWith('</html>')).toBe(true)
    },
  )
})
