import { ArrowRightIcon } from 'lucide-react'
import type { Lang } from '@/lib/api'

const EXAMPLES: { lang: Lang; text: string }[] = [
  { lang: 'en', text: 'What human oversight does the AI Act require for high-risk AI systems?' },
  {
    lang: 'en',
    text: 'Within how many hours must a controller notify a personal data breach under the GDPR?',
  },
  {
    lang: 'pl',
    text: 'Jakie środki zarządzania ryzykiem w cyberbezpieczeństwie muszą wdrożyć podmioty objęte NIS2?',
  },
  { lang: 'pl', text: 'Kiedy przetwarzanie danych osobowych jest zgodne z prawem według RODO?' },
]

export function EmptyState({
  onAsk,
  disabled,
}: {
  onAsk: (text: string) => void
  disabled: boolean
}) {
  return (
    <div className="max-w-[44rem] pt-6">
      <div>
        <p className="font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          EU regulation, cited
        </p>
        <h1 className="mt-4 max-w-[28ch] font-serif text-[2.25rem] leading-[1.15] font-medium tracking-[-0.01em] text-foreground">
          Ask the GDPR, the AI Act and NIS2 — in English or Polish.
        </h1>
        <p className="mt-5 max-w-[62ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          Answers come only from the official texts. Every claim cites the article, paragraph or
          recital it rests on, and the citations are checked against the retrieved passages before
          the answer is shown. When the texts do not cover a question, the answer says so. The
          sources are the English and Polish texts of the GDPR, the AI Act and NIS2, split into
          articles, paragraphs, points, recitals and annexes.
        </p>

        <h2 className="mt-12 font-mono text-[0.6875rem] tracking-[0.14em] text-muted-foreground uppercase">
          Try a question
        </h2>
        <ul className="mt-3 divide-y divide-border/70 border-y border-border/70">
          {EXAMPLES.map((example) => (
            <li key={example.text}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAsk(example.text)}
                className="group flex w-full items-center gap-4 px-1 py-3.5 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
              >
                <span className="w-6 shrink-0 font-mono text-[0.6875rem] text-muted-foreground uppercase">
                  {example.lang}
                </span>
                <span
                  lang={example.lang}
                  className="flex-1 font-serif text-[1.0625rem] text-foreground/90"
                >
                  {example.text}
                </span>
                <ArrowRightIcon
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-cite group-focus-visible:text-cite"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
