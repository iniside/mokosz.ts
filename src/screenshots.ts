// The README images (decision 0002): chat.png from the latest answered conversation and chat.gif of
// a question asked through the UI.
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, parse, relative, sep } from 'node:path'
import { Client, type ClientBase } from 'pg'
import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { UuidSchema } from './api/validation.ts'
import { CommandError } from './command.ts'

export const WIDTH = 1440
export const HEIGHT = 900
export const GIF_WIDTH = 1000
export const TYPE_CHUNK = 3
export const TYPE_MS = 90
export const POLL_S = 0.4
export const MAX_FRAME_MS = 1200
export const HOLD_MS = 4000
export const MAX_FRAMES = 160
export const PALETTE_SAMPLES = 16
export const LOAD_TIMEOUT_MS = 30_000
export const ANSWER_TIMEOUT_S = 600.0

export const SCROLLER = 'main .overflow-y-auto'
export const ANSWER = 'section[aria-label="Answer"]'
export const METRICS = '[aria-label="Run metrics"]'
export const FAILED = '[role="alert"]'
export const QUESTION_INPUT = '[aria-label="Your question"]'
// Paused animations keep identical moments pixel-identical, so waiting collapses into one frame.
export const STILL =
  '*, *::before, *::after { animation: none !important; transition: none !important; }'

const LATEST = `
    SELECT conversation_id FROM runs
    WHERE kind = 'qa'
    GROUP BY conversation_id
    HAVING bool_or(status = 'done')
    ORDER BY max(created_at) DESC, conversation_id DESC
    LIMIT 1
`

export class ScreenshotError extends Error {
  override name = 'ScreenshotError'
}

/** An RGB image, three bytes per pixel, row by row. */
export interface Image {
  readonly width: number
  readonly height: number
  readonly data: Buffer
}

export interface Shot {
  readonly image: Image
  readonly atMs: number
}

export interface Frame {
  readonly image: Image
  readonly durationMs: number
}

export async function latestConversation(client: ClientBase): Promise<string | null> {
  const { rows } = await client.query<{ conversation_id: string }>(LATEST)
  return rows[0]?.conversation_id ?? null
}

export function collapse(
  shots: readonly Shot[],
  { maxFrameMs = MAX_FRAME_MS, holdMs = HOLD_MS, maxFrames = MAX_FRAMES } = {},
): Frame[] {
  const distinct: Shot[] = []
  for (const shot of shots) {
    const last = distinct.at(-1)
    if (last !== undefined && shot.image.data.equals(last.image.data)) continue
    distinct.push(shot)
  }
  if (distinct.length === 0) throw new Error('no shots to collapse')
  const frames = distinct.map((shot, i) => {
    const next = distinct[i + 1]
    const durationMs = next === undefined ? holdMs : Math.min(next.atMs - shot.atMs, maxFrameMs)
    return { image: shot.image, durationMs }
  })
  if (frames.length <= maxFrames) return frames
  const keep = new Set(
    Array.from({ length: maxFrames }, (_, i) =>
      Math.round((i * (frames.length - 1)) / (maxFrames - 1)),
    ),
  )
  const kept: Frame[] = []
  for (const [i, frame] of frames.entries()) {
    if (keep.has(i)) {
      kept.push(frame)
    } else {
      const last = kept.pop()!
      kept.push({ image: last.image, durationMs: last.durationMs + frame.durationMs })
    }
  }
  return kept
}

const raw = (image: Image) =>
  sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })

export async function decode(png: Buffer): Promise<Image> {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data }
}

export async function resize(image: Image, width: number, height: number): Promise<Image> {
  const data = await raw(image)
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer()
  return { width, height, data }
}

/** The palette's colours, three bytes each. */
export type Palette = Uint8Array

// The quantised mosaic's colours in order of first appearance. libvips keeps one GIF palette entry
// for transparency, so these are at most 255 and the frames remapped to them encode losslessly.
async function quantise(mosaic: Image): Promise<Palette> {
  const gif = await raw(mosaic).gif({ colours: 256, dither: 0 }).toBuffer()
  const pixels = await sharp(gif).removeAlpha().raw().toBuffer()
  const seen = new Uint8Array(1 << 24)
  const colours: number[] = []
  for (let i = 0; i < pixels.length; i += 3) {
    const key = (pixels[i]! << 16) | (pixels[i + 1]! << 8) | pixels[i + 2]!
    if (seen[key] === 1) continue
    seen[key] = 1
    colours.push(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
  }
  return Uint8Array.from(colours)
}

/** One palette from up to PALETTE_SAMPLES frames stacked into a mosaic. */
export async function palette(images: readonly Image[]): Promise<Palette> {
  const sampled = samples(images)
  const { width, height } = sampled[0]!
  return quantise({
    width,
    height: height * sampled.length,
    data: Buffer.concat(sampled.map((image) => image.data)),
  })
}

/** Every step-th image, with step = max(1, floor(n / PALETTE_SAMPLES)). */
export function samples<T>(images: readonly T[]): T[] {
  const step = Math.max(1, Math.floor(images.length / PALETTE_SAMPLES))
  return images.filter((_, i) => i % step === 0)
}

/**
 * The palette index of each pixel, without dithering: a pixel takes the entry nearest to its colour
 * with the two low bits of each channel cleared; a tie goes to the lower index.
 */
export function remapper(entries: Palette): (image: Image) => Uint8Array {
  const cache = new Int16Array(1 << 18).fill(-1)
  const nearest = (r: number, g: number, b: number): number => {
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < entries.length; i += 3) {
      const distance =
        (r - entries[i]!) ** 2 + (g - entries[i + 1]!) ** 2 + (b - entries[i + 2]!) ** 2
      if (distance < bestDistance) {
        best = i / 3
        bestDistance = distance
      }
    }
    return best
  }
  return (image) => {
    const indices = new Uint8Array(image.width * image.height)
    for (let p = 0; p < indices.length; p++) {
      const [r, g, b] = [
        image.data[p * 3]! >> 2,
        image.data[p * 3 + 1]! >> 2,
        image.data[p * 3 + 2]! >> 2,
      ]
      const key = r | (g << 6) | (b << 12)
      let index = cache[key]!
      if (index === -1) {
        index = nearest(r << 2, g << 2, b << 2)
        cache[key] = index
      }
      indices[p] = index
    }
    return indices
  }
}

export async function writeGif(
  frames: readonly Frame[],
  path: string,
  width: number = GIF_WIDTH,
): Promise<void> {
  if (frames.length === 0) throw new ScreenshotError('no frames to write')
  const { width: sourceW, height: sourceH } = frames[0]!.image
  const height = Math.round((sourceH * width) / sourceW)
  const resized: Image[] = []
  for (const frame of frames) resized.push(await resize(frame.image, width, height))
  const entries = await palette(resized)
  const remap = remapper(entries)
  // A frame equal to the previous one after quantising adds its milliseconds to it; GIF delays are
  // whole centiseconds, truncated.
  const kept: { indices: Uint8Array; durationMs: number }[] = []
  for (const [i, image] of resized.entries()) {
    const indices = remap(image)
    const durationMs = frames[i]!.durationMs
    const last = kept.at(-1)
    if (last !== undefined && Buffer.from(indices).equals(Buffer.from(last.indices))) {
      last.durationMs += durationMs
    } else {
      kept.push({ indices, durationMs })
    }
  }
  const pixels = Buffer.alloc(width * height * 3 * kept.length)
  let offset = 0
  for (const { indices } of kept) {
    for (const index of indices) {
      pixels[offset++] = entries[index * 3]!
      pixels[offset++] = entries[index * 3 + 1]!
      pixels[offset++] = entries[index * 3 + 2]!
    }
  }
  await mkdir(dirname(path), { recursive: true })
  // A frame quantised again by libvips keeps its exact colours only without palette reuse.
  await sharp(pixels, {
    raw: { width, height: height * kept.length, channels: 3, pageHeight: height },
  })
    .gif({
      colours: 256,
      dither: 0,
      interPaletteMaxError: 0,
      loop: 0,
      delay: kept.map((frame) => Math.trunc(frame.durationMs / 10) * 10),
    })
    .toFile(path)
}

export async function writePng(image: Image, path: string): Promise<void> {
  await raw(image).png({ compressionLevel: 9 }).toFile(path)
}

async function screenshot(page: Page): Promise<Image> {
  return decode(await page.screenshot())
}

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: STILL })
  await page.evaluate('document.fonts.ready.then(() => true)')
}

export async function captureHero(
  page: Page,
  baseUrl: string,
  conversation: string,
): Promise<Image> {
  await page.goto(`${baseUrl}/?c=${conversation}`)
  await settle(page)
  await page.locator(ANSWER).first().waitFor({ timeout: LOAD_TIMEOUT_MS })
  await page.locator(METRICS).first().waitFor({ timeout: LOAD_TIMEOUT_MS })
  await page.$eval(SCROLLER, (element) => element.scrollTo({ top: 0 }))
  await page.waitForTimeout(300)
  return screenshot(page)
}

export async function captureQuestion(
  page: Page,
  baseUrl: string,
  question: string,
  answerTimeoutS: number = ANSWER_TIMEOUT_S,
): Promise<Shot[]> {
  await page.goto(baseUrl)
  await settle(page)
  const start = performance.now()
  const shots: Shot[] = []

  const take = async (): Promise<void> => {
    const image = await screenshot(page)
    shots.push({ image, atMs: Math.round(performance.now() - start) })
  }

  const box = page.locator(QUESTION_INPUT)
  await box.waitFor({ timeout: LOAD_TIMEOUT_MS })
  await box.click()
  await take()
  const characters = Array.from(question)
  for (let i = 0; i < characters.length; i += TYPE_CHUNK) {
    await page.keyboard.type(characters.slice(i, i + TYPE_CHUNK).join(''))
    await page.waitForTimeout(TYPE_MS)
    await take()
  }
  await page.keyboard.press('Enter')
  const deadline = performance.now() + answerTimeoutS * 1000
  while ((await page.locator(METRICS).count()) === 0) {
    if ((await page.locator(FAILED).count()) > 0) {
      throw new ScreenshotError(`the run failed: ${await page.locator(FAILED).first().innerText()}`)
    }
    if (performance.now() > deadline) {
      throw new ScreenshotError(`no answer within ${answerTimeoutS.toFixed(0)} s`)
    }
    await take()
    await page.waitForTimeout(POLL_S * 1000)
  }
  if ((await page.locator(ANSWER).count()) === 0) {
    throw new ScreenshotError('the run finished without an answer')
  }
  await page.waitForTimeout(500)
  await take()
  return shots
}

// Playwright has no common error class: its errors are an Error, a TimeoutError or a
// TargetClosedError by name.
const PLAYWRIGHT_ERRORS = new Set(['Error', 'TimeoutError', 'TargetClosedError'])

function isPlaywrightError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !(error instanceof ScreenshotError) &&
    PLAYWRIGHT_ERRORS.has(error.name)
  )
}

const firstLine = (text: string): string => text.split(/\r\n|\r|\n/)[0]!

export interface ScreenshotDeps {
  launch(): Promise<Pick<Browser, 'newContext' | 'close'>>
  captureHero: typeof captureHero
  captureQuestion: typeof captureQuestion
  writeGif(frames: readonly Frame[], path: string): Promise<void>
  writePng: typeof writePng
}

const BROWSER: ScreenshotDeps = {
  launch: () => chromium.launch(),
  captureHero,
  captureQuestion,
  writeGif,
  writePng,
}

function staging(path: string): string {
  const { dir, name, ext } = parse(path)
  return join(dir, `${name}.partial${ext}`)
}

export async function takeScreenshots(
  baseUrl: string,
  conversation: string,
  question: string,
  png: string,
  gif: string,
  deps: ScreenshotDeps = BROWSER,
): Promise<number> {
  const base = baseUrl.replace(/\/+$/, '')
  let hero: Image
  let shots: Shot[]
  try {
    const browser = await deps.launch()
    try {
      const context = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
      })
      hero = await deps.captureHero(await context.newPage(), base, conversation)
      shots = await deps.captureQuestion(await context.newPage(), base, question)
    } finally {
      await browser.close()
    }
  } catch (error) {
    if (isPlaywrightError(error))
      throw new ScreenshotError(firstLine(error.message), { cause: error })
    throw error
  }
  const frames = collapse(shots)
  const staged = new Map([
    [gif, staging(gif)],
    [png, staging(png)],
  ])
  try {
    await deps.writeGif(frames, staged.get(gif)!)
    await deps.writePng(hero, staged.get(png)!)
    for (const [final, temporary] of staged) await rename(temporary, final)
  } finally {
    for (const temporary of staged.values()) await rm(temporary, { force: true })
  }
  return frames.length
}

export interface ScreenshotsOptions {
  url: string
  conversation?: string
  question: string
}

async function answeredConversation(databaseUrl: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  let found: string | null
  try {
    found = await latestConversation(client)
  } finally {
    await client.end()
  }
  if (found === null) {
    throw new CommandError('No conversation with an answer: ask a question in the UI first')
  }
  return found
}

function conversationId(text: string): string {
  const parsed = UuidSchema.safeParse(text)
  if (!parsed.success) throw new CommandError(`Not a conversation id: ${text}`)
  return parsed.data
}

export async function screenshotsCommand(
  root: string,
  databaseUrl: string,
  options: ScreenshotsOptions,
  deps: ScreenshotDeps = BROWSER,
): Promise<void> {
  const target =
    options.conversation === undefined
      ? await answeredConversation(databaseUrl)
      : conversationId(options.conversation)
  const images = join(root, 'docs', 'img')
  const [png, gif] = [join(images, 'chat.png'), join(images, 'chat.gif')]
  let frames: number
  try {
    frames = await takeScreenshots(options.url, target, options.question, png, gif, deps)
  } catch (error) {
    if (error instanceof ScreenshotError) {
      throw new CommandError(`Screenshots failed: ${error.message}`)
    }
    throw error
  }
  for (const path of [png, gif]) {
    const shown = relative(root, path).split(sep).join('/')
    process.stdout.write(`${shown}: ${((await stat(path)).size / 1e6).toFixed(2)} MB\n`)
  }
  process.stdout.write(`Conversation ${target}; GIF ${frames} frames\n`)
}
