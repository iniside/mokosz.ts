import { cn } from '@/lib/utils'
import type { Answer as AnswerData, CitationRef } from '@/lib/api'
import { NOT_FOUND } from '@/features/chat/format'

export interface OpenCitation {
  key: string
  label: string
  lang: AnswerData['lang']
}

function CitationChip({
  citationKey,
  citation,
  active,
  onOpen,
}: {
  citationKey: string
  citation: CitationRef | undefined
  active: boolean
  onOpen: () => void
}) {
  const label = citation?.label ?? citationKey
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Open the cited text of ${label}`}
      className={cn(
        'mx-0.5 inline-flex translate-y-[-0.08em] items-center rounded-[4px] border border-cite/30 bg-cite/[0.06] px-1.5 font-mono text-[0.75rem] leading-5 whitespace-nowrap text-cite transition-colors outline-none hover:border-cite/60 hover:bg-cite/15 focus-visible:ring-2 focus-visible:ring-cite/70',
        active && 'border-cite/70 bg-cite/20',
      )}
    >
      {label}
    </button>
  )
}

export function Answer({
  answer,
  citations,
  openKey,
  onOpen,
}: {
  answer: AnswerData
  citations: Record<string, CitationRef>
  openKey: string | null
  onOpen: (citation: OpenCitation) => void
}) {
  const verified = !answer.not_found && answer.claims.length > 0

  return (
    <section lang={answer.lang} aria-label="Answer">
      <p className="mb-4 flex items-center gap-3 font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        <span>Answer</span>
        <span className="rounded-sm border border-border px-1 tracking-normal">{answer.lang}</span>
        {verified && (
          <span className="tracking-normal normal-case text-muted-foreground/70">
            citations verified
          </span>
        )}
      </p>
      {answer.not_found && (
        <p className="font-serif text-[1.0625rem] text-muted-foreground italic">
          {NOT_FOUND[answer.lang]}
        </p>
      )}
      {answer.claims.length > 0 && (
        <ol className="space-y-3.5">
          {answer.claims.map((claim, i) => (
            <li key={i} className="grid grid-cols-[1.75rem_1fr]">
              <span
                className="pt-[0.3rem] font-mono text-xs text-muted-foreground/60 tabular-nums"
                aria-hidden
              >
                {i + 1}
              </span>
              <p className="font-serif text-[1.0625rem] leading-[1.7] text-foreground/90">
                {claim.text}{' '}
                {claim.citations.map((key, j) => (
                  <CitationChip
                    key={`${key}-${j}`}
                    citationKey={key}
                    citation={citations[key]}
                    active={openKey === key}
                    onOpen={() =>
                      onOpen({ key, label: citations[key]?.label ?? key, lang: answer.lang })
                    }
                  />
                ))}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
