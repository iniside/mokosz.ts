import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ArrowUpIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-[3px] border border-border bg-muted/40 px-1 font-mono text-[0.6875rem] text-muted-foreground">
      {children}
    </kbd>
  )
}

export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  disabledHint,
  status,
  error,
}: {
  value: string
  onChange: (value: string) => void
  onSend: (text: string) => void
  disabled: boolean
  disabledHint: string
  status: string | null
  error: string | null
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const canSend = !disabled && value.trim().length > 0

  const sent = useRef(false)

  useEffect(() => {
    if (disabled || !sent.current) return
    sent.current = false
    input.current?.focus()
  }, [disabled])

  const submit = () => {
    sent.current = true
    onSend(value)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (canSend) submit()
  }

  return (
    <div className="border-t border-border/70 bg-background px-8 pt-4 pb-5">
      <form
        className="mx-auto w-full max-w-[56rem]"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) submit()
        }}
      >
        {error && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-input bg-card/50 py-2 pr-2 pl-4 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20 has-disabled:opacity-70">
          <Textarea
            ref={input}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            aria-label="Your question"
            placeholder={
              disabled
                ? disabledHint
                : 'Ask about the GDPR, the AI Act or NIS2, in English or Polish'
            }
            className="max-h-48 min-h-7 resize-none rounded-none border-0 bg-transparent px-0 py-1 text-[0.9375rem] shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          />
          <Button type="submit" size="icon" disabled={!canSend} aria-label="Send question">
            <ArrowUpIcon />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-4 px-1 text-xs text-muted-foreground">
          <span aria-live="polite">{status}</span>
          <span className="flex items-center gap-1.5">
            <Key>Enter</Key> to send <span className="text-muted-foreground/50">·</span>{' '}
            <Key>Shift</Key>+<Key>Enter</Key> new line
          </span>
        </div>
      </form>
    </div>
  )
}
