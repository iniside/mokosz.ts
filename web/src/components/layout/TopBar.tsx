import type { ReactNode } from 'react'

export function TopBar({ actions }: { actions?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border/70 px-6">
      <span className="font-serif text-xl font-semibold tracking-tight">Mokosz</span>
      <span className="h-4 w-px bg-border" aria-hidden />
      <span className="font-mono text-[0.6875rem] tracking-[0.12em] text-muted-foreground uppercase">
        EU regulation Q&amp;A
      </span>
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </header>
  )
}
