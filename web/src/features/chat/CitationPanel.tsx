import { useEffect, useState, type RefObject } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError, getCitation, type CitationText, type Lang } from '@/lib/api'
import type { OpenCitation } from '@/features/chat/Answer'

type Loaded = { id: string; text: CitationText } | { id: string; error: string }

function errorMessage(error: unknown, lang: Lang): string {
  if (error instanceof ApiError && error.status === 404) {
    return lang === 'pl'
      ? 'This passage has no Polish text in the corpus.'
      : 'This passage has no English text in the corpus.'
  }
  if (error instanceof ApiError && error.unreachable) return 'The API is unreachable.'
  return error instanceof Error ? error.message : 'The text could not be loaded.'
}

function useCitationText(key: string | null, lang: Lang): Loaded | null {
  const [texts, setTexts] = useState<Record<string, CitationText>>({})
  const [failure, setFailure] = useState<{ id: string; error: string } | null>(null)
  const id = key ? `${key}|${lang}` : null
  const cachedText = id === null ? undefined : texts[id]
  const cached = cachedText !== undefined

  useEffect(() => {
    if (!key || !id || cached) return
    const controller = new AbortController()
    getCitation(key, lang, controller.signal).then(
      (text) => setTexts((current) => ({ ...current, [id]: text })),
      (error: unknown) => {
        if (!controller.signal.aborted) setFailure({ id, error: errorMessage(error, lang) })
      },
    )
    return () => controller.abort()
  }, [key, lang, id, cached])

  if (!id) return null
  if (cachedText) return { id, text: cachedText }
  return failure?.id === id ? failure : null
}

export function CitationPanel({
  open,
  onLangChange,
  onClose,
  returnFocus,
}: {
  open: OpenCitation | null
  onLangChange: (lang: Lang) => void
  onClose: () => void
  returnFocus: RefObject<HTMLElement | null>
}) {
  const lang = open?.lang ?? 'en'
  const loaded = useCitationText(open?.key ?? null, lang)
  const text = loaded && 'text' in loaded ? loaded.text : null

  return (
    <Sheet open={open !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 border-border/80 bg-background p-0 sm:max-w-[34rem]"
        onCloseAutoFocus={(event) => {
          // The sheet is opened from a chip, not a Radix Trigger, so focus is returned by hand.
          if (!returnFocus.current?.isConnected) return
          event.preventDefault()
          returnFocus.current.focus()
        }}
      >
        <SheetHeader className="gap-3 border-b border-border/70 px-7 pt-6 pb-5">
          <div className="flex items-center gap-4 pr-10">
            <span className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
              Cited text
            </span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              spacing={0}
              value={lang}
              onValueChange={(value) => value && onLangChange(value as Lang)}
              aria-label="Language of the cited text"
              className="ml-auto"
            >
              <ToggleGroupItem value="en" aria-label="English" className="font-mono text-xs">
                EN
              </ToggleGroupItem>
              <ToggleGroupItem value="pl" aria-label="Polish" className="font-mono text-xs">
                PL
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <SheetTitle className="font-mono text-[0.9375rem] font-medium text-cite">
            {text?.label ?? open?.label}
          </SheetTitle>
          <SheetDescription className="font-serif text-[1.375rem] leading-snug text-foreground">
            {text ? (text.heading ?? text.act) : ' '}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-7 py-6" lang={lang}>
          {!loaded && (
            <div className="space-y-3" aria-label="Loading the cited text">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {loaded && 'error' in loaded && (
            <p role="alert" className="text-sm text-destructive">
              {loaded.error}
            </p>
          )}
          {text && (
            <p className="font-serif text-[1.0625rem] leading-[1.75] whitespace-pre-line text-foreground/90">
              {text.text}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-4 border-t border-border/70 px-7 py-3 font-mono text-[0.6875rem] text-muted-foreground tabular-nums">
          <span>{open?.key}</span>
          <span>{lang === 'pl' ? 'Polish text' : 'English text'}</span>
        </footer>
      </SheetContent>
    </Sheet>
  )
}
