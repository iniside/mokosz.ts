import type { Lang, NodeName, TurnMetrics } from '@/lib/api'

const LOCAL_PREFIX = 'ollama_chat/'

export const STEP_LABELS: Record<NodeName, string> = {
  router: 'Understanding the question',
  retriever: 'Searching',
  answerer: 'Writing the answer',
  verifier: 'Checking citations',
}

export const NOT_FOUND: Record<Lang, string> = {
  en: 'Not found in the sources.',
  pl: 'Nie znaleziono w źródłach.',
}

const integer = new Intl.NumberFormat('en-US')
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })

export function modelName(model: string): string {
  return model.startsWith(LOCAL_PREFIX) ? model.slice(LOCAL_PREFIX.length) : model
}

export function formatCost(metrics: Pick<TurnMetrics, 'cost_usd' | 'models'>): string {
  const cost = Number(metrics.cost_usd)
  const local = metrics.models.length > 0 && metrics.models.every((m) => m.startsWith(LOCAL_PREFIX))
  if (cost === 0 && local) return '$0 · local GPU'
  return `$${cost.toFixed(4)}`
}

export function formatLatency(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

export function formatTokens(count: number): string {
  return integer.format(count)
}

export function formatTime(iso: string): string {
  return clock.format(new Date(iso))
}

export function retries(path: NodeName[]): number {
  return Math.max(0, path.filter((node) => node === 'answerer').length - 1)
}
