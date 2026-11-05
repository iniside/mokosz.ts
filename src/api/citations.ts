import { Hono } from 'hono'
import { z } from 'zod'
import { LANGUAGES } from '../ingest/acts.ts'
import { citationText } from '../runs/turns.ts'
import type { AppState } from './state.ts'
import { parse } from './validation.ts'

const LangQuery = z.enum(LANGUAGES, { error: "lang must be 'en' or 'pl'" })

export function citationRoutes(state: AppState): Hono {
  const routes = new Hono()

  routes.get('/citations/:celex/:element_id', async (c) => {
    const lang = parse(c, LangQuery, c.req.query('lang'))
    if (!lang.ok) return lang.response
    const celex = c.req.param('celex')
    const elementId = c.req.param('element_id')
    const found = await citationText(state.pool, celex, elementId, lang.value)
    if (found === null) return c.json({ detail: 'citation not found' }, 404)
    return c.json({
      citation_key: `${celex}#${elementId}`,
      lang: lang.value,
      act: found.act,
      article: found.article,
      heading: found.heading,
      label: found.label,
      text: found.text,
    })
  })

  return routes
}
