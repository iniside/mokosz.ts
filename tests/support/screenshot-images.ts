import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp, { type Metadata } from 'sharp'
import { onTestFinished } from 'vitest'
import type { Image } from '../../src/screenshots.ts'

export type Rgb = readonly [number, number, number]

export const COLOURS: Rgb[] = [
  [10, 10, 12],
  [200, 40, 40],
  [40, 200, 90],
  [30, 60, 220],
]

export function solid(colour: Rgb, [width, height]: [number, number] = [1440, 900]): Image {
  const data = Buffer.alloc(width * height * 3)
  for (let p = 0; p < width * height; p++) data.set(colour, p * 3)
  return { width, height, data }
}

export function pixel(image: Image, x: number, y: number): Rgb {
  const at = (y * image.width + x) * 3
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!]
}

export async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mokosz-screenshots-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** The GIF's metadata and every frame composed in RGB. */
export async function readGif(path: string): Promise<{ meta: Metadata; frames: Image[] }> {
  // Read through a buffer: libvips keeps a file it opened by path open, which Windows cannot delete.
  const bytes = await readFile(path)
  const meta = await sharp(bytes, { animated: true }).metadata()
  const data = await sharp(bytes, { animated: true }).removeAlpha().raw().toBuffer()
  const [width, height] = [meta.width, meta.pageHeight ?? meta.height]
  const size = width * height * 3
  const frames = Array.from({ length: meta.pages ?? 1 }, (_, i) => ({
    width,
    height,
    data: data.subarray(i * size, (i + 1) * size),
  }))
  return { meta, frames }
}
