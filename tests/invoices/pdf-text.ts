import { extractTextItems } from 'unpdf'

// A text item within 3 pt of a line's baseline is on that line, and a gap over 3 pt between items
// is a space.
const Y_TOLERANCE = 3
const X_TOLERANCE = 3

interface Item {
  str: string
  x: number
  y: number
  width: number
}

function lineText(items: Item[]): string {
  let text = ''
  let end: number | null = null
  for (const item of items.toSorted((a, b) => a.x - b.x)) {
    if (end !== null && item.x - end > X_TOLERANCE) text += ' '
    text += item.str
    end = item.x + item.width
  }
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .join(' ')
}

/** The text lines of a PDF, top to bottom, each with single spaces between its words. */
export async function pdfLines(bytes: Uint8Array): Promise<string[]> {
  const { items: pages } = await extractTextItems(new Uint8Array(bytes))
  const lines: string[] = []
  for (const page of pages) {
    const rows: { y: number; items: Item[] }[] = []
    for (const item of page.filter((candidate) => candidate.str.trim() !== '')) {
      const row = rows.find((known) => Math.abs(known.y - item.y) <= Y_TOLERANCE)
      if (row === undefined) rows.push({ y: item.y, items: [item] })
      else row.items.push(item)
    }
    for (const row of rows.toSorted((a, b) => b.y - a.y)) lines.push(lineText(row.items))
  }
  return lines
}
