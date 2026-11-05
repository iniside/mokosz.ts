import { CheckIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { STEP_LABELS, formatLatency } from '@/features/chat/format'
import type { Connection, StepVisit } from '@/features/chat/useRunStream'

export function StepIndicator({
  visits,
  connection,
}: {
  visits: StepVisit[]
  connection: Connection
}) {
  const shown: StepVisit[] = visits.length > 0 ? visits : [{ node: 'router', latencyMs: null }]
  const active = shown.findLast((visit) => visit.latencyMs === null)
  const seen = new Map<string, number>()

  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {active ? `${STEP_LABELS[active.node]}…` : 'Finishing…'}
      </p>
      <ol className="max-w-sm space-y-1.5 font-mono text-[0.8125rem]" aria-label="Run progress">
        {shown.map((visit, i) => {
          const count = (seen.get(visit.node) ?? 0) + 1
          seen.set(visit.node, count)
          const done = visit.latencyMs !== null
          return (
            <li key={i} className="flex items-center gap-3">
              <span className="flex size-4 items-center justify-center" aria-hidden>
                {done ? (
                  <CheckIcon className="size-3.5 text-muted-foreground" />
                ) : (
                  <span className="size-2 rounded-full bg-cite motion-safe:animate-pulse" />
                )}
              </span>
              <span className={done ? 'text-muted-foreground' : 'text-foreground'}>
                {STEP_LABELS[visit.node]}
                {done ? '' : '…'}
              </span>
              {count > 1 && (
                <span className="rounded-sm border border-cite/30 px-1 text-[0.6875rem] text-cite">
                  retry
                </span>
              )}
              {done && (
                <span className="ml-auto text-muted-foreground/70 tabular-nums">
                  {formatLatency(visit.latencyMs ?? 0)}
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {connection === 'reconnecting' && (
        <p className="mt-3 font-mono text-xs text-muted-foreground">
          Connection lost. Reconnecting…
        </p>
      )}
      {connection === 'lost' && (
        <p role="alert" className="mt-3 font-mono text-xs text-destructive">
          Lost the connection to this run. The run continues; reload the page to follow it.
        </p>
      )}
      <div className="mt-6 space-y-2.5" aria-hidden>
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  )
}
