import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  ScreenshotError,
  collapse,
  decode,
  palette,
  remapper,
  resize,
  samples,
  writeGif,
  type Frame,
  type Image,
  type Shot,
} from '../src/screenshots.ts'
import { describe, expect, test } from './support/harness.ts'
import { COLOURS, pixel, readGif, scratch, solid, type Rgb } from './support/screenshot-images.ts'

/** Fills the rectangle (x0, y0) to (x1, y1), exclusive of the far edge. */
function paste(image: Image, colour: Rgb, [x0, y0, x1, y1]: [number, number, number, number]) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) image.data.set(colour, (y * image.width + x) * 3)
  }
}

const near = (value: Rgb, colour: Rgb): boolean =>
  value.every((channel, i) => Math.abs(channel - colour[i]!) <= 8)

const copy = (image: Image): Image => ({ ...image, data: Buffer.from(image.data) })

/** The index of the entry nearest to the colour with its two low bits cleared; ties go lower. */
function nearestEntry(entries: Uint8Array, [r, g, b]: Rgb): number {
  const [cr, cg, cb] = [r & ~3, g & ~3, b & ~3]
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < entries.length / 3; i++) {
    const distance =
      (cr - entries[i * 3]!) ** 2 +
      (cg - entries[i * 3 + 1]!) ** 2 +
      (cb - entries[i * 3 + 2]!) ** 2
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

describe('collapse', () => {
  test('merges identical shots and holds the last', () => {
    const [a, b, c] = COLOURS.slice(0, 3).map((colour) => solid(colour, [8, 5]))
    const shots: Shot[] = [
      { image: a!, atMs: 0 },
      { image: copy(a!), atMs: 100 },
      { image: b!, atMs: 400 },
      { image: copy(b!), atMs: 9000 },
      { image: c!, atMs: 9500 },
    ]

    const frames = collapse(shots, { maxFrameMs: 1000, holdMs: 3000 })

    expect(frames.map((frame) => pixel(frame.image, 0, 0))).toEqual(COLOURS.slice(0, 3))
    expect(frames.map((frame) => frame.durationMs)).toEqual([400, 1000, 3000])
  })

  test('keeps a frame that returns to an earlier one', () => {
    const [a, b] = COLOURS.slice(0, 2).map((colour) => solid(colour, [8, 5]))
    const shots: Shot[] = [
      { image: a!, atMs: 0 },
      { image: b!, atMs: 100 },
      { image: copy(a!), atMs: 300 },
    ]

    const frames = collapse(shots, { maxFrameMs: 1000, holdMs: 3000 })

    expect(frames.map((frame) => pixel(frame.image, 0, 0))).toEqual([
      COLOURS[0],
      COLOURS[1],
      COLOURS[0],
    ])
    expect(frames.map((frame) => frame.durationMs)).toEqual([100, 200, 3000])
  })

  test('caps frames and keeps the time', () => {
    const shots = Array.from({ length: 10 }, (_, i) => ({
      image: solid([i, 0, 0], [4, 4]),
      atMs: i * 100,
    }))

    const frames = collapse(shots, { maxFrameMs: 1000, holdMs: 2000, maxFrames: 4 })

    expect(frames.map((frame) => pixel(frame.image, 0, 0))).toEqual(
      [0, 3, 6, 9].map((i) => [i, 0, 0]),
    )
    expect(frames.map((frame) => frame.durationMs)).toEqual([300, 300, 300, 2000])
  })

  // Kept indices are round(i * (n - 1) / (maxFrames - 1)); a dropped frame adds its time to the
  // kept frame before it.
  test.for<[number, number, [number, number][]]>([
    [
      4,
      4,
      [
        [0, 100],
        [1, 100],
        [2, 100],
        [3, 2000],
      ],
    ],
    [
      6,
      3,
      [
        [0, 300],
        [3, 200],
        [5, 2000],
      ],
    ],
    [
      7,
      4,
      [
        [0, 200],
        [2, 200],
        [4, 200],
        [6, 2000],
      ],
    ],
    [
      5,
      2,
      [
        [0, 400],
        [4, 2000],
      ],
    ],
  ])('%i shots capped at %i frames', ([count, maxFrames, expected]) => {
    const shots = Array.from({ length: count }, (_, i) => ({
      image: solid([i, 0, 0], [4, 4]),
      atMs: i * 100,
    }))

    const frames = collapse(shots, { maxFrameMs: 1000, holdMs: 2000, maxFrames })

    expect(frames.map((frame) => [pixel(frame.image, 0, 0)[0], frame.durationMs])).toEqual(expected)
  })

  test('without shots throws', () => {
    expect(() => collapse([])).toThrow('no shots to collapse')
  })
})

function greyRamp(): Image {
  const ramp = solid([0, 0, 0])
  for (let y = 0; y < 900; y++) {
    for (let x = 0; x < 1440; x++) {
      const grey = Math.round((x * 255) / 1439)
      ramp.data.set([grey, grey, grey], (y * 1440 + x) * 3)
    }
  }
  return ramp
}

/** The largest distance of the 1000 px wide image from the 1440 px ramp sampled at its centres. */
function rampError(image: Image): number {
  let worst = 0
  for (let y = 0; y < image.height; y += 50) {
    for (let x = 4; x < 996; x++) {
      const grey = ((((x + 0.5) * 1440) / 1000 - 0.5) * 255) / 1439
      for (const channel of pixel(image, x, y)) worst = Math.max(worst, Math.abs(channel - grey))
    }
  }
  return worst
}

describe('writeGif', () => {
  test('scales, loops and keeps the durations', async () => {
    const durations = [120, 800, 300, 4000]
    const frames: Frame[] = COLOURS.map((colour, i) => ({
      image: solid(colour),
      durationMs: durations[i]!,
    }))
    paste(frames[1]!.image, [250, 250, 250], [100, 100, 700, 160])
    const path = join(await scratch(), 'img', 'chat.gif')

    await writeGif(frames, path, 1000)

    const { meta, frames: decoded } = await readGif(path)
    expect(meta.format).toBe('gif')
    expect([meta.width, meta.pageHeight]).toEqual([1000, 625])
    expect(meta.pages).toBe(4)
    expect(meta.loop).toBe(0)
    expect(meta.delay).toEqual(durations)
    expect(near(pixel(decoded[1]!, 200, 90), [250, 250, 250])).toBe(true)
    expect(near(pixel(decoded[1]!, 500, 300), COLOURS[1]!)).toBe(true)
    expect(near(pixel(decoded[3]!, 500, 300), COLOURS[3]!)).toBe(true)
  })

  test('the resize filters 7 px stripes into intermediate greys', async () => {
    const stripes = solid([0, 0, 0])
    for (let y = 0; y < 900; y++) {
      for (let x = 0; x < 1440; x++) {
        if (Math.floor(x / 7) % 2 === 1) stripes.data.set([255, 255, 255], (y * 1440 + x) * 3)
      }
    }

    const resized = await resize(stripes, 1000, 625)

    const row = Array.from({ length: 1000 }, (_, x) => pixel(resized, x, 300)[0])
    expect(row.filter((grey) => grey > 32 && grey < 223).length).toBeGreaterThan(100)
  })

  test('the resize keeps a grey ramp linear within one level', async () => {
    expect(rampError(await resize(greyRamp(), 1000, 625))).toBeLessThanOrEqual(1)
  })

  test('the GIF keeps a grey ramp within eight levels', async () => {
    const path = join(await scratch(), 'chat.gif')

    await writeGif(
      [
        { image: solid(COLOURS[0]!), durationMs: 100 },
        { image: greyRamp(), durationMs: 100 },
      ],
      path,
      1000,
    )

    expect(rampError((await readGif(path)).frames[1]!)).toBeLessThanOrEqual(8)
  })

  test('does not dither', async () => {
    const [width, height] = [1440, 900]
    const gradient = solid([0, 0, 0])
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        gradient.data.set(
          [Math.floor((x * 255) / (width - 1)), Math.floor((y * 255) / (height - 1)), 128],
          (y * width + x) * 3,
        )
      }
    }
    const path = join(await scratch(), 'chat.gif')

    await writeGif([{ image: gradient, durationMs: 100 }], path, 1000)

    const decoded = (await readGif(path)).frames[0]!
    const row = Array.from({ length: 1000 }, (_, x) => pixel(decoded, x, 300).join())
    expect(row.slice(1).filter((value, x) => value !== row[x]).length).toBeLessThan(64)
  })

  // Delays are whole centiseconds, truncated; frames equal after the palette mapping merge first.
  test.for<[string, Rgb[], number[], number[]]>([
    [
      'distinct frames',
      [COLOURS[0]!, COLOURS[1]!, COLOURS[2]!],
      [435, 1125, 4000],
      [430, 1120, 4000],
    ],
    [
      'two frames that map to one palette entry',
      [
        [10, 10, 12],
        [11, 10, 12],
        [200, 40, 40],
      ],
      [105, 1095, 1125],
      [1200, 1120],
    ],
    [
      'short frames',
      [COLOURS[0]!, COLOURS[1]!, COLOURS[2]!, COLOURS[3]!],
      [5, 10, 19, 4000],
      [0, 10, 10, 4000],
    ],
  ])('durations of %s', async ([, colours, durations, delays]) => {
    const path = join(await scratch(), 'chat.gif')
    const frames = colours.map((colour, i) => ({
      image: solid(colour, [40, 25]),
      durationMs: durations[i]!,
    }))

    await writeGif(frames, path)

    const { meta } = await readGif(path)
    expect(meta.pages).toBe(delays.length)
    expect(meta.delay).toEqual(delays)
  })

  test.for<[number, number[]]>([
    [0, []],
    [5, [0, 1, 2, 3, 4]],
    [17, Array.from({ length: 17 }, (_, i) => i)],
    [32, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]],
    [33, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32]],
    [160, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150]],
  ])('the palette samples of %i frames', ([count, sampled]) => {
    expect(samples(Array.from({ length: count }, (_, i) => i))).toEqual(sampled)
  })

  test('a PNG with alpha decodes to RGB: the alpha is dropped', async () => {
    const png = await sharp(Buffer.from([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]), {
      raw: { width: 3, height: 1, channels: 4 },
    })
      .png()
      .toBuffer()

    const image = await decode(png)

    expect([image.width, image.height]).toEqual([3, 1])
    expect([...image.data]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255])
  })

  test('without frames raises', async () => {
    const path = join(await scratch(), 'chat.gif')

    await expect(writeGif([], path)).rejects.toThrow(new ScreenshotError('no frames to write'))
    await expect(stat(path)).rejects.toThrow('ENOENT')
  })

  // The height is the source height scaled to the width, rounded half up.
  test.for<[[number, number], number, [number, number]]>([
    [[1440, 900], 1000, [1000, 625]],
    [[40, 25], 1000, [1000, 625]],
    [[3, 2], 1000, [1000, 667]],
    [[1000, 333], 500, [500, 167]],
    [[900, 1440], 1000, [1000, 1600]],
  ])('a frame of %j at width %i is %j', async ([source, width, size]) => {
    const path = join(await scratch(), 'chat.gif')

    await writeGif([{ image: solid(COLOURS[3]!, source), durationMs: 100 }], path, width)

    const [frame] = (await readGif(path)).frames
    expect([frame!.width, frame!.height]).toEqual(size)
  })

  test('every frame is exactly its pixels mapped to the one palette of the sampled frames', async () => {
    const frames: Frame[] = Array.from({ length: 20 }, (_, f) => {
      const image = solid([18, 18, 18], [720, 450])
      for (let y = 40; y < 40 + f * 15; y++) {
        for (let x = 60; x < 660; x++)
          image.data.set([(x * 7) % 256, 200 - f, (y * 3) % 256], (y * 720 + x) * 3)
      }
      return { image, durationMs: 100 }
    })
    const path = join(await scratch(), 'chat.gif')

    await writeGif(frames, path, 500)

    const resized: Image[] = []
    for (const frame of frames) resized.push(await resize(frame.image, 500, 313))
    const entries = await palette(resized)
    const { frames: decoded } = await readGif(path)
    expect(entries.length / 3).toBeLessThanOrEqual(255)
    expect(decoded).toHaveLength(20)
    const known = new Map<number, number>()
    for (const [i, image] of resized.entries()) {
      const expected = Buffer.alloc(image.data.length)
      for (let at = 0; at < image.data.length; at += 3) {
        const colour = (image.data[at]! << 16) | (image.data[at + 1]! << 8) | image.data[at + 2]!
        let index = known.get(colour)
        if (index === undefined) {
          index = nearestEntry(entries, [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!])
          known.set(colour, index)
        }
        expected.set(entries.subarray(index * 3, index * 3 + 3), at)
      }
      expect(decoded[i]!.data.equals(expected), `frame ${i}`).toBe(true)
    }
  })
})

describe('the palette mapping', () => {
  test.for([
    ['blue', (step: number): Rgb => [100, 100, step]],
    ['green', (step: number): Rgb => [100, step, 100]],
  ] as const)('pixels that differ only in %s map as the nearest entry does', ([, colour]) => {
    const entries = Uint8Array.from(
      Array.from({ length: 70 }, (_, i) => [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256]).flat(),
    )
    const pixels = Array.from({ length: 64 }, (_, i) => colour(i * 4 + (i % 4)))
    const image: Image = { width: pixels.length, height: 1, data: Buffer.from(pixels.flat()) }
    const expected = pixels.map((rgb) => nearestEntry(entries, rgb))

    expect(new Set(expected).size).toBeGreaterThan(4)
    expect(Array.from(remapper(entries)(image))).toEqual(expected)
  })

  test.for<[string, number[][], number[][], number[]]>([
    [
      'each pixel takes the nearest entry',
      [
        [0, 0, 0],
        [255, 255, 255],
        [255, 0, 0],
        [0, 0, 255],
      ],
      [
        [3, 3, 3],
        [250, 250, 250],
        [200, 10, 10],
        [20, 20, 200],
        [255, 255, 255],
      ],
      [0, 1, 2, 3, 1],
    ],
    [
      'the two low bits of each channel are cleared first',
      [
        [0, 0, 0],
        [3, 3, 3],
      ],
      [[3, 3, 3]],
      [0],
    ],
    [
      'a tie goes to the lower index',
      [
        [8, 0, 0],
        [0, 0, 0],
      ],
      [[4, 0, 0]],
      [0],
    ],
    [
      'a tie goes to the lower index, whichever entry it is',
      [
        [0, 0, 0],
        [8, 0, 0],
      ],
      [[4, 0, 0]],
      [0],
    ],
  ])('%s', ([, entries, pixels, indices]) => {
    const image: Image = { width: pixels.length, height: 1, data: Buffer.from(pixels.flat()) }

    expect(Array.from(remapper(Uint8Array.from(entries.flat()))(image))).toEqual(indices)
  })
})
