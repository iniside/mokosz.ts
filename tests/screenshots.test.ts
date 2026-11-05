import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from 'pg'
import { errors, type BrowserContextOptions, type Page } from 'playwright'
import sharp from 'sharp'
import { beforeEach, vi } from 'vitest'
import { main } from '../src/cli.ts'
import { upgradeHead } from '../src/db/index.ts'
import * as screenshots from '../src/screenshots.ts'
import {
  ANSWER,
  FAILED,
  METRICS,
  ScreenshotError,
  captureHero,
  captureQuestion,
  latestConversation,
  screenshotsCommand,
  takeScreenshots,
  type ScreenshotDeps,
  type Shot,
} from '../src/screenshots.ts'
import { clearSettingsCache } from '../src/settings.ts'
import { describe, expect, test } from './support/harness.ts'
import { COLOURS, pixel, readGif, scratch, solid } from './support/screenshot-images.ts'

const QUESTION = 'How long?'

// The fakes stand in for Playwright objects.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-parameters
const cast = <T>(fake: unknown): T => fake as T

type Call = readonly unknown[]

class FakeLocator {
  readonly page: FakePage
  readonly selector: string

  constructor(page: FakePage, selector: string) {
    this.page = page
    this.selector = selector
  }

  first(): FakeLocator {
    this.page.log.push(['first', this.selector])
    return this
  }

  async count(): Promise<number> {
    this.page.log.push(['count', this.selector])
    return this.page.count(this.selector)
  }

  async innerText(): Promise<string> {
    this.page.log.push(['innerText', this.selector])
    return this.page.alert
  }

  async waitFor(options: { timeout: number }): Promise<void> {
    this.page.log.push(['waitFor', this.selector, options.timeout])
  }

  async click(): Promise<void> {
    this.page.log.push(['click', this.selector])
  }
}

class FakeKeyboard {
  readonly log: Call[]
  typed = ''
  pressed: string[] = []

  constructor(log: Call[]) {
    this.log = log
  }

  async type(text: string): Promise<void> {
    this.log.push(['type', text])
    this.typed += text
  }

  async press(key: string): Promise<void> {
    this.log.push(['press', key])
    this.pressed.push(key)
  }
}

/** A page whose calls are logged; waitForTimeout advances the faked performance clock. */
class FakePage {
  readonly counts: Record<string, number>
  readonly alert: string
  readonly log: Call[] = []
  readonly keyboard = new FakeKeyboard(this.log)
  // The METRICS count stays 0 for this many polls, then reads counts[METRICS].
  metricsAfter = 0

  constructor(counts: Record<string, number>, alert = '') {
    this.counts = counts
    this.alert = alert
  }

  count(selector: string): number {
    if (selector === '[aria-label="Run metrics"]' && this.metricsAfter > 0) {
      this.metricsAfter -= 1
      return 0
    }
    return this.counts[selector] ?? 0
  }

  locator(selector: string): FakeLocator {
    this.log.push(['locator', selector])
    return new FakeLocator(this, selector)
  }

  async screenshot(): Promise<Buffer> {
    this.log.push(['screenshot'])
    const image = solid([this.keyboard.typed.length, 0, 0], [4, 4])
    return sharp(image.data, { raw: { width: 4, height: 4, channels: 3 } })
      .png()
      .toBuffer()
  }

  async goto(url: string): Promise<void> {
    this.log.push(['goto', url])
  }

  async addStyleTag(options: { content: string }): Promise<void> {
    this.log.push(['addStyleTag', options.content])
  }

  async evaluate(expression: string): Promise<void> {
    this.log.push(['evaluate', expression])
  }

  async waitForTimeout(ms: number): Promise<void> {
    this.log.push(['waitForTimeout', ms])
    vi.advanceTimersByTime(ms)
  }

  async $eval(
    selector: string,
    run: (element: { scrollTo(options: object): void }) => void,
  ): Promise<void> {
    this.log.push(['$eval', selector])
    run({ scrollTo: (options) => this.log.push(['scrollTo', options]) })
  }
}

function fakeClock(): () => void {
  vi.useFakeTimers({ toFake: ['performance'] })
  return () => {
    vi.useRealTimers()
  }
}

const ask = (page: FakePage, answerTimeoutS?: number): Promise<Shot[]> =>
  captureQuestion(cast<Page>(page), 'http://ui', QUESTION, answerTimeoutS)

// The selectors and style the capture uses, written out.
const STILL_CSS =
  '*, *::before, *::after { animation: none !important; transition: none !important; }'
const FONTS = 'document.fonts.ready.then(() => true)'
const BOX = '[aria-label="Your question"]'
const RUN_METRICS = '[aria-label="Run metrics"]'
const ALERT = '[role="alert"]'
const ANSWER_SECTION = 'section[aria-label="Answer"]'

const poll: Call[] = [
  ['locator', RUN_METRICS],
  ['count', RUN_METRICS],
  ['locator', ALERT],
  ['count', ALERT],
  ['screenshot'],
  ['waitForTimeout', 400],
]

describe('captureQuestion', () => {
  beforeEach(fakeClock)

  test('types, sends and returns the answer frames', async () => {
    const page = new FakePage({ [METRICS]: 1, [ANSWER]: 1 })

    const shots = await ask(page)

    expect(page.keyboard.typed).toBe(QUESTION)
    expect(page.keyboard.pressed).toEqual(['Enter'])
    expect(pixel(shots.at(-1)!.image, 0, 0)).toEqual([QUESTION.length, 0, 0])
  })

  test('makes the page calls in order and shoots once per chunk, poll and answer', async () => {
    const page = new FakePage({ [METRICS]: 1, [ANSWER]: 1 })
    page.metricsAfter = 2

    const shots = await ask(page)

    expect(page.log).toEqual([
      ['goto', 'http://ui'],
      ['addStyleTag', STILL_CSS],
      ['evaluate', FONTS],
      ['locator', BOX],
      ['waitFor', BOX, 30000],
      ['click', BOX],
      ['screenshot'],
      ['type', 'How'],
      ['waitForTimeout', 90],
      ['screenshot'],
      ['type', ' lo'],
      ['waitForTimeout', 90],
      ['screenshot'],
      ['type', 'ng?'],
      ['waitForTimeout', 90],
      ['screenshot'],
      ['press', 'Enter'],
      ...poll,
      ...poll,
      ['locator', RUN_METRICS],
      ['count', RUN_METRICS],
      ['locator', ANSWER_SECTION],
      ['count', ANSWER_SECTION],
      ['waitForTimeout', 500],
      ['screenshot'],
    ])
    expect(shots).toHaveLength(1 + Math.ceil(QUESTION.length / 3) + 2 + 1)
    expect(shots.map((shot) => shot.atMs)).toEqual([0, 90, 180, 270, 270, 670, 1570])
    expect(shots.map((shot) => pixel(shot.image, 0, 0)[0])).toEqual([0, 3, 6, 9, 9, 9, 9])
  })

  test('types a question by code points, three at a time', async () => {
    const page = new FakePage({ [METRICS]: 1, [ANSWER]: 1 })

    await captureQuestion(cast<Page>(page), 'http://ui', 'a😀bcd')

    expect(page.log.filter(([call]) => call === 'type')).toEqual([
      ['type', 'a😀b'],
      ['type', 'cd'],
    ])
  })

  test('the answer deadline is 600 s after Enter, not sooner', async () => {
    const page = new FakePage({})
    let thrown: unknown

    await ask(page).catch((error: unknown) => {
      thrown = error
    })

    expect(thrown).toEqual(new ScreenshotError('no answer within 600 s'))
    const polls = page.log.filter(([call, ms]) => call === 'waitForTimeout' && ms === 400)
    expect(polls).toHaveLength(1501)
    expect(page.log.filter(([call]) => call === 'screenshot')).toHaveLength(1 + 3 + 1501)
  })

  test('reports a failed run', async () => {
    const page = new FakePage({ [FAILED]: 1 }, 'The run failed before an answer was verified.')

    await expect(ask(page)).rejects.toThrow(
      new ScreenshotError('the run failed: The run failed before an answer was verified.'),
    )
    expect(page.log.slice(-7)).toEqual([
      ['locator', RUN_METRICS],
      ['count', RUN_METRICS],
      ['locator', ALERT],
      ['count', ALERT],
      ['locator', ALERT],
      ['first', ALERT],
      ['innerText', ALERT],
    ])
  })

  test('gives up after the timeout', async () => {
    await expect(ask(new FakePage({}), -1)).rejects.toThrow(
      new ScreenshotError('no answer within -1 s'),
    )
  })

  test('rejects metrics without an answer', async () => {
    await expect(ask(new FakePage({ [METRICS]: 1 }))).rejects.toThrow(
      new ScreenshotError('the run finished without an answer'),
    )
  })
})

describe('captureHero', () => {
  beforeEach(fakeClock)

  test('opens the conversation, waits for the answer and metrics and scrolls to the top', async () => {
    const page = new FakePage({})
    page.keyboard.typed = 'abcde'

    const hero = await captureHero(cast<Page>(page), 'http://ui', CONVERSATION)

    expect(page.log).toEqual([
      ['goto', `http://ui/?c=${CONVERSATION}`],
      ['addStyleTag', STILL_CSS],
      ['evaluate', FONTS],
      ['locator', ANSWER_SECTION],
      ['first', ANSWER_SECTION],
      ['waitFor', ANSWER_SECTION, 30000],
      ['locator', RUN_METRICS],
      ['first', RUN_METRICS],
      ['waitFor', RUN_METRICS, 30000],
      ['$eval', 'main .overflow-y-auto'],
      ['scrollTo', { top: 0 }],
      ['waitForTimeout', 300],
      ['screenshot'],
    ])
    expect([hero.width, hero.height, ...pixel(hero, 3, 3)]).toEqual([4, 4, 5, 0, 0])
  })
})

async function images(): Promise<[string, string]> {
  const directory = await scratch()
  const [png, gif] = [join(directory, 'chat.png'), join(directory, 'chat.gif')]
  await writeFile(png, 'old png')
  await writeFile(gif, 'old gif')
  return [png, gif]
}

interface Calls {
  contexts: BrowserContextOptions[]
  hero: [string, string][]
  question: [string, string][]
  closed: number
}

function stubBrowser(overrides: Partial<ScreenshotDeps> = {}): [ScreenshotDeps, Calls] {
  const calls: Calls = { contexts: [], hero: [], question: [], closed: 0 }
  const shots: Shot[] = [
    { image: solid(COLOURS[1]!, [40, 25]), atMs: 0 },
    { image: solid(COLOURS[2]!, [40, 25]), atMs: 100 },
  ]
  const deps: ScreenshotDeps = {
    launch: async () =>
      cast({
        newContext: async (options: BrowserContextOptions) => {
          calls.contexts.push(options)
          return { newPage: async () => null }
        },
        close: async () => {
          calls.closed += 1
        },
      }),
    captureHero: async (_page, baseUrl, conversation) => {
      calls.hero.push([baseUrl, conversation])
      return solid(COLOURS[3]!, [40, 25])
    },
    captureQuestion: async (_page, baseUrl, question) => {
      calls.question.push([baseUrl, question])
      return shots
    },
    writeGif: screenshots.writeGif,
    writePng: screenshots.writePng,
    ...overrides,
  }
  return [deps, calls]
}

const CONVERSATION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

describe('takeScreenshots', () => {
  test('replaces both images', async () => {
    const [png, gif] = await images()
    const [deps, calls] = stubBrowser()

    expect(await takeScreenshots('http://ui/', CONVERSATION, QUESTION, png, gif, deps)).toBe(2)

    const [hero, animation] = [await sharp(await readFile(png)).metadata(), await readGif(gif)]
    expect([hero.format, animation.meta.format, animation.meta.pages]).toEqual(['png', 'gif', 2])
    expect((await readdir(join(png, '..'))).toSorted()).toEqual(['chat.gif', 'chat.png'])
    expect(calls.contexts).toEqual([
      {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      },
    ])
    expect(calls.hero).toEqual([['http://ui', CONVERSATION]])
    expect(calls.question).toEqual([['http://ui', QUESTION]])
    expect(calls.closed).toBe(1)
  })

  test('keeps both images when the GIF fails', async () => {
    const [png, gif] = await images()
    const [deps] = stubBrowser({
      writeGif: async (_frames, path) => {
        await writeFile(path, 'half')
        throw new ScreenshotError('encoder broke')
      },
    })

    await expect(
      takeScreenshots('http://ui/', CONVERSATION, QUESTION, png, gif, deps),
    ).rejects.toThrow(new ScreenshotError('encoder broke'))

    expect([await readFile(png, 'utf8'), await readFile(gif, 'utf8')]).toEqual([
      'old png',
      'old gif',
    ])
    expect((await readdir(join(png, '..'))).toSorted()).toEqual(['chat.gif', 'chat.png'])
  })

  test('keeps both images when the PNG fails', async () => {
    const [png, gif] = await images()
    const [deps] = stubBrowser({
      writePng: async (_image, path) => {
        await writeFile(path, 'half')
        throw new Error('disk full')
      },
    })

    await expect(
      takeScreenshots('http://ui/', CONVERSATION, QUESTION, png, gif, deps),
    ).rejects.toThrow('disk full')

    expect([await readFile(png, 'utf8'), await readFile(gif, 'utf8')]).toEqual([
      'old png',
      'old gif',
    ])
    expect((await readdir(join(png, '..'))).toSorted()).toEqual(['chat.gif', 'chat.png'])
  })

  test('a Playwright error becomes a ScreenshotError with its first line', async () => {
    const [png, gif] = await images()
    const launch = new Error(
      "browserType.launch: Executable doesn't exist at C:\\ms-playwright\nline two",
    )
    const timeout = new errors.TimeoutError(
      'locator.waitFor: Timeout 30000ms exceeded.\r\nCall log:',
    )
    const [failedLaunch] = stubBrowser({ launch: () => Promise.reject(launch) })
    const [timedOut, calls] = stubBrowser({ captureHero: () => Promise.reject(timeout) })

    await expect(
      takeScreenshots('http://ui', CONVERSATION, QUESTION, png, gif, failedLaunch),
    ).rejects.toThrow(
      new ScreenshotError("browserType.launch: Executable doesn't exist at C:\\ms-playwright"),
    )
    await expect(
      takeScreenshots('http://ui', CONVERSATION, QUESTION, png, gif, timedOut),
    ).rejects.toThrow(new ScreenshotError('locator.waitFor: Timeout 30000ms exceeded.'))
    expect(calls.closed).toBe(1)
    expect([await readFile(png, 'utf8'), await readFile(gif, 'utf8')]).toEqual([
      'old png',
      'old gif',
    ])
  })

  test('an error of another kind is not turned into a ScreenshotError', async () => {
    const [png, gif] = await images()
    const bug = new TypeError('x is undefined')
    const [deps] = stubBrowser({ captureQuestion: () => Promise.reject(bug) })

    await expect(takeScreenshots('http://ui', CONVERSATION, QUESTION, png, gif, deps)).rejects.toBe(
      bug,
    )
  })
})

interface Ran {
  code: number
  stdout: string
  stderr: string
}

async function capture(run: () => Promise<number>): Promise<Ran> {
  let [stdout, stderr] = ['', '']
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  try {
    return { code: await run(), stdout, stderr }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

const UNREACHABLE_DB = 'postgresql://mokosz:mokosz@127.0.0.1:1/mokosz'

/** mokosz screenshots with the given root, database and browser in place of the real ones. */
function runCli(
  args: string[],
  root: string,
  deps: ScreenshotDeps = stubBrowser()[0],
  databaseUrl: string = UNREACHABLE_DB,
): Promise<Ran> {
  return capture(() =>
    main(['screenshots', ...args], {
      screenshots: (options) => screenshotsCommand(root, databaseUrl, options, deps),
    }),
  )
}

async function withDatabaseUrl<T>(url: string, body: () => Promise<T>): Promise<T> {
  vi.stubEnv('DATABASE_URL', url)
  clearSettingsCache()
  try {
    return await body()
  } finally {
    vi.unstubAllEnvs()
    clearSettingsCache()
  }
}

describe('mokosz screenshots', () => {
  test('the default command loads the module, finds the repository and checks the id', async () => {
    const { code, stdout, stderr } = await capture(() =>
      main(['screenshots', '--conversation', 'nope']),
    )

    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Not a conversation id: nope\n',
    })
  })

  test('an error of another kind from the capture propagates', async () => {
    const bug = new TypeError('x is undefined')
    const [deps] = stubBrowser({ captureQuestion: () => Promise.reject(bug) })

    await expect(runCli(['--conversation', CONVERSATION], await scratch(), deps)).rejects.toBe(bug)
  })

  test('without an answered conversation says so', async ({ throwawayDatabaseUrl }) => {
    await upgradeHead(throwawayDatabaseUrl)

    const { code, stderr } = await runCli([], await scratch(), undefined, throwawayDatabaseUrl)

    expect(code).toBe(1)
    expect(stderr).toBe('No conversation with an answer: ask a question in the UI first\n')
  })

  test('without --conversation it shoots the latest answered conversation', async ({
    throwawayDatabaseUrl,
  }) => {
    await upgradeHead(throwawayDatabaseUrl)
    let answered = ''
    await withClient(throwawayDatabaseUrl, async (client) => {
      answered = await addConversation(client, ['done', '2999-01-01'])
    })
    const [deps, calls] = stubBrowser()

    const { code } = await runCli([], await scratch(), deps, throwawayDatabaseUrl)

    expect(code).toBe(0)
    expect(calls.hero).toEqual([['http://localhost:4173', answered]])
  })

  test('the database comes from the settings', async ({ throwawayDatabaseUrl }) => {
    await upgradeHead(throwawayDatabaseUrl)

    const { code, stderr } = await withDatabaseUrl(throwawayDatabaseUrl, () =>
      capture(() => main(['screenshots'])),
    )

    expect(code).toBe(1)
    expect(stderr).toBe('No conversation with an answer: ask a question in the UI first\n')
  })

  test('prints both images and the frames of the conversation it shot', async () => {
    const root = await scratch()
    const [deps, calls] = stubBrowser()

    const { code, stdout, stderr } = await runCli(
      ['--conversation', CONVERSATION.toUpperCase(), '--url', 'http://ui//'],
      root,
      deps,
    )

    const size = async (name: string) =>
      ((await stat(join(root, 'docs', 'img', name))).size / 1e6).toFixed(2)
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.split('\n')).toEqual([
      `docs/img/chat.png: ${await size('chat.png')} MB`,
      `docs/img/chat.gif: ${await size('chat.gif')} MB`,
      `Conversation ${CONVERSATION}; GIF 2 frames`,
      '',
    ])
    expect(calls.hero).toEqual([['http://ui', CONVERSATION]])
    expect(calls.question).toEqual([
      [
        'http://ui',
        'Which obligations does the AI Act place on deployers of high-risk AI systems?',
      ],
    ])
    expect((await readdir(join(root, 'docs', 'img'))).toSorted()).toEqual(['chat.gif', 'chat.png'])
  })

  test('a failed capture is reported as Screenshots failed', async () => {
    const [deps] = stubBrowser({
      captureHero: () => Promise.reject(new ScreenshotError('the run failed: boom')),
    })

    const { code, stdout, stderr } = await runCli(
      ['--conversation', CONVERSATION],
      await scratch(),
      deps,
    )

    expect({ code, stdout }).toEqual({ code: 1, stdout: '' })
    expect(stderr).toBe('Screenshots failed: the run failed: boom\n')
  })
})

describe('the --conversation id', () => {
  test.for<[string, string]>([
    [CONVERSATION, CONVERSATION],
    [CONVERSATION.toUpperCase(), CONVERSATION],
  ])('%s is conversation %s', async ([text, id]) => {
    const [deps, calls] = stubBrowser()

    const { code } = await runCli(['--conversation', text], await scratch(), deps)

    expect(code).toBe(0)
    expect(calls.hero.map(([, conversation]) => conversation)).toEqual([id])
  })

  test.for([
    'nope',
    `{${CONVERSATION}}`,
    CONVERSATION.replaceAll('-', ''),
    `urn:uuid:${CONVERSATION}`,
    `${CONVERSATION}0`,
    '',
  ])('%j is not a conversation id', async (text) => {
    const [deps, calls] = stubBrowser()

    const { code, stdout, stderr } = await runCli(['--conversation', text], await scratch(), deps)

    expect({ code, stdout, stderr }).toEqual({
      code: 1,
      stdout: '',
      stderr: `Not a conversation id: ${text}\n`,
    })
    expect(calls.hero).toEqual([])
  })
})

const RUN =
  'INSERT INTO runs (kind, thread_id, conversation_id, question, status, profile, created_at)' +
  " VALUES ('qa', $1, $2, 'q', $3, 'local-qwen', $4)"

async function addRun(client: Client, conversation: string, status: string, createdAt: string) {
  await client.query(RUN, [conversation, conversation, status, createdAt])
}

async function addConversation(client: Client, ...runs: [string, string][]): Promise<string> {
  const id = randomUUID()
  for (const [status, createdAt] of runs) await addRun(client, id, status, createdAt)
  return id
}

async function withClient(url: string, body: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    await body(client)
  } finally {
    await client.end()
  }
}

describe('latestConversation', () => {
  test('picks the latest run among the answered', async ({ testSettings }) => {
    await withClient(testSettings.databaseUrl, async (client) => {
      await client.query('BEGIN')
      try {
        const older = await addConversation(client, ['done', '2999-01-01'], ['done', '2999-01-02'])
        const answered = await addConversation(
          client,
          ['done', '2999-01-03'],
          ['failed', '2999-01-05'],
        )
        await addConversation(client, ['failed', '2999-01-06'])
        await addConversation(client, ['running', '2999-01-07'])

        expect(await latestConversation(client)).toBe(answered)

        await addRun(client, older, 'done', '2999-01-04')
        expect(await latestConversation(client)).toBe(answered)

        await addRun(client, older, 'done', '2999-01-08')
        const [invoice, runId] = [randomUUID(), randomUUID()]
        await client.query(
          "INSERT INTO invoices (id, status, run_id, thread_id, pdf_path) VALUES ($1, 'done', $2, $3, 'x.pdf')",
          [invoice, runId, `invoice:${invoice}`],
        )
        await client.query(
          'INSERT INTO runs (id, kind, thread_id, invoice_id, status, profile, created_at)' +
            " VALUES ($1, 'extraction', $2, $3, 'done', 'local-qwen', '2999-01-09')",
          [runId, `invoice:${invoice}`, invoice],
        )
        expect(await latestConversation(client)).toBe(older)
      } finally {
        await client.query('ROLLBACK')
      }
    })
  })

  test('is null without an answer', async ({ throwawayDatabaseUrl }) => {
    await upgradeHead(throwawayDatabaseUrl)
    await withClient(throwawayDatabaseUrl, async (client) => {
      await addConversation(client, ['failed', '2999-01-01'], ['running', '2999-01-02'])

      expect(await latestConversation(client)).toBeNull()
    })
  })
})
