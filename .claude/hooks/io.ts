import { readFileSync, writeSync } from 'node:fs'

export type HookInput = {
  tool_name?: unknown
  tool_input?: { command?: unknown; model?: unknown } | null
  tool_response?: unknown
  cwd?: unknown
}

export function readInput(): HookInput | null {
  try {
    const data: unknown = JSON.parse(readFileSync(0, 'utf8'))
    return data !== null && typeof data === 'object' ? (data as HookInput) : null
  } catch {
    return null
  }
}

// Synchronous, so the decision is written before process.exit() on every platform.
export function emit(output: object): void {
  writeSync(1, JSON.stringify(output) + '\n')
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
