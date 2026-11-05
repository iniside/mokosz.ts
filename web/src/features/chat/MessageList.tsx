import type { ReactNode } from 'react'
import type { Turn } from '@/lib/api'
import { Answer, type OpenCitation } from '@/features/chat/Answer'
import { MetricsStrip } from '@/features/chat/MetricsStrip'
import { StepIndicator } from '@/features/chat/StepIndicator'
import { formatTime } from '@/features/chat/format'
import type { RunStream } from '@/features/chat/useRunStream'

function TurnFrame({
  index,
  time,
  question,
  children,
}: {
  index: number
  time: string | null
  question: string
  children: ReactNode
}) {
  return (
    <article
      aria-label={`Question ${index}`}
      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-6 border-b border-border/60 py-10 first:pt-2 last:border-b-0"
    >
      <div className="pt-1.5 font-mono text-xs text-muted-foreground tabular-nums">
        <div className="text-foreground/70">{String(index).padStart(2, '0')}</div>
        {time && <div className="mt-1 text-muted-foreground/60">{time}</div>}
      </div>
      <div className="min-w-0">
        <h2 className="max-w-[60ch] font-serif text-[1.375rem] leading-snug font-medium text-foreground">
          {question}
        </h2>
        <div className="mt-6">{children}</div>
      </div>
    </article>
  )
}

function RunFailed({ message }: { message: string | null | undefined }) {
  return (
    <div role="alert" className="border-l-2 border-destructive/70 pl-4">
      <p className="text-sm font-medium text-destructive">
        The run failed before an answer was verified.
      </p>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        {message === undefined
          ? 'Loading the error…'
          : (message ?? 'No error message was recorded.')}
      </p>
    </div>
  )
}

export function MessageList({
  turns,
  activeRunId,
  pending,
  stream,
  runErrors,
  openKey,
  onOpen,
}: {
  turns: Turn[]
  activeRunId: string | null
  pending: string | null
  stream: RunStream
  runErrors: Record<string, string | null>
  openKey: string | null
  onOpen: (citation: OpenCitation) => void
}) {
  return (
    <div>
      <h1 className="sr-only">
        {turns[0] ? `Conversation: ${turns[0].question}` : 'New conversation'}
      </h1>
      {turns.map((turn, i) => (
        <TurnFrame
          key={turn.run_id}
          index={i + 1}
          time={formatTime(turn.created_at)}
          question={turn.question}
        >
          {turn.status === 'running' &&
            (turn.run_id === activeRunId ? (
              <StepIndicator visits={stream.visits} connection={stream.connection} />
            ) : (
              <StepIndicator visits={[]} connection="open" />
            ))}
          {turn.status === 'failed' && <RunFailed message={runErrors[turn.run_id]} />}
          {turn.status === 'done' && turn.answer && (
            <Answer
              answer={turn.answer}
              citations={turn.citations}
              openKey={openKey}
              onOpen={onOpen}
            />
          )}
          {turn.status !== 'running' && <MetricsStrip metrics={turn.metrics} />}
        </TurnFrame>
      ))}
      {pending !== null && (
        <TurnFrame index={turns.length + 1} time={null} question={pending}>
          <StepIndicator visits={[]} connection="open" />
        </TurnFrame>
      )}
    </div>
  )
}
