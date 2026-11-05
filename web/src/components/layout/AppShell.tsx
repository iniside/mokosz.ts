import type { ReactNode } from 'react'
import { TopBar } from '@/components/layout/TopBar'

export function AppShell({ actions, children }: { actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-svh flex-col">
      <TopBar actions={actions} />
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  )
}
