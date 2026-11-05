import { Fragment, type ReactNode } from 'react'
import type { TurnMetrics } from '@/lib/api'
import { formatCost, formatLatency, formatTokens, modelName, retries } from '@/features/chat/format'

function Metric({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={wide ? 'flex basis-full items-baseline gap-2' : 'flex items-baseline gap-2'}>
      <dt className="text-[0.625rem] tracking-[0.12em] text-muted-foreground/60 uppercase">
        {label}
      </dt>
      <dd className="text-muted-foreground">{children}</dd>
    </div>
  )
}

export function MetricsStrip({ metrics }: { metrics: TurnMetrics }) {
  const retried = retries(metrics.path)
  const seen = new Set<string>()

  return (
    <dl
      aria-label="Run metrics"
      className="mt-8 flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-dashed border-border pt-3 font-mono text-xs tabular-nums"
    >
      {metrics.path.length > 0 && (
        <Metric label="Path" wide>
          {metrics.path.map((node, i) => {
            const again = seen.has(node)
            seen.add(node)
            return (
              <Fragment key={i}>
                {i > 0 && <span className="px-1 text-muted-foreground/50">→</span>}
                <span className={again ? 'text-cite' : undefined}>{node}</span>
              </Fragment>
            )
          })}
          {retried > 0 && (
            <span className="ml-2 text-cite">
              ({retried} {retried === 1 ? 'retry' : 'retries'})
            </span>
          )}
        </Metric>
      )}
      <Metric label="Tokens">
        {formatTokens(metrics.tokens_in)} in / {formatTokens(metrics.tokens_out)} out
      </Metric>
      <Metric label="Cost">{formatCost(metrics)}</Metric>
      {metrics.latency_ms !== null && (
        <Metric label="Latency">{formatLatency(metrics.latency_ms)}</Metric>
      )}
      {metrics.models.length > 0 && (
        <Metric label="Model">{metrics.models.map(modelName).join(', ')}</Metric>
      )}
    </dl>
  )
}
