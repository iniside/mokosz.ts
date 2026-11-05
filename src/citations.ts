import { ACTS, type Lang } from './ingest/acts.ts'

const ACT_BY_CELEX = new Map<string, string>(ACTS)

const PARAGRAPH = /^(\d{3})\.(\d{3})$/
const POINT = /^art_(\d+)\.pt_\d+$/
const BLOCK = /^art_(\d+)\.p_\d+$/
const RECITAL = /^rct_(\d+)$/
const ANNEX = /^anx_([IVXLC]+)\.(?:p|r)_\d+$/
const POINT_START = /^\s*\(?(\d+|[a-z]+)\)/
const ALL_DIGITS = /^\d+$/

const ARTICLE: Record<Lang, string> = { en: 'Art.', pl: 'art.' }
const RECITAL_WORD: Record<Lang, string> = { en: 'Recital', pl: 'motyw' }
const ANNEX_WORD: Record<Lang, string> = { en: 'Annex', pl: 'załącznik' }

function paragraph(article: string, number: string, lang: Lang): string {
  if (lang === 'en') return `Art. ${article}(${number})`
  return `art. ${article} ust. ${number}`
}

function point(article: string, text: string, lang: Lang, key: string): string {
  const match = POINT_START.exec(text)
  if (match === null) {
    const start = Array.from(text).slice(0, 20).join('')
    throw new Error(
      `point ${key} (${lang}) does not start with a point label: ${JSON.stringify(start)}`,
    )
  }
  const marker = match[1]!
  if (lang === 'en') return `Art. ${article}(${marker})`
  return `art. ${article} ${ALL_DIGITS.test(marker) ? 'pkt' : 'lit.'} ${marker}`
}

export function label(citationKey: string, lang: Lang, text: string): string {
  const hash = citationKey.indexOf('#')
  const celex = hash === -1 ? citationKey : citationKey.slice(0, hash)
  const elementId = hash === -1 ? '' : citationKey.slice(hash + 1)
  const act = ACT_BY_CELEX.get(celex)
  if (act === undefined) {
    throw new Error(`unknown CELEX in citation key ${JSON.stringify(citationKey)}`)
  }
  let part: string
  let match: RegExpExecArray | null
  if ((match = PARAGRAPH.exec(elementId))) {
    part = paragraph(String(Number(match[1])), String(Number(match[2])), lang)
  } else if ((match = POINT.exec(elementId))) {
    part = point(match[1]!, text, lang, citationKey)
  } else if ((match = BLOCK.exec(elementId))) {
    part = `${ARTICLE[lang]} ${match[1]}`
  } else if ((match = RECITAL.exec(elementId))) {
    part = `${RECITAL_WORD[lang]} ${match[1]}`
  } else if ((match = ANNEX.exec(elementId))) {
    part = `${ANNEX_WORD[lang]} ${match[1]}`
  } else {
    throw new Error(`unknown element id in citation key ${JSON.stringify(citationKey)}`)
  }
  return `${act} ${part}`
}
