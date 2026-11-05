import { Decimal } from '../decimal.ts'

export interface LLMCall {
  readonly node: string
  readonly model: string
  readonly tokensIn: number
  readonly tokensOut: number
  readonly latencyMs: number
  readonly costUsd: Decimal
  readonly error: string | null
}

export interface Usage {
  readonly models: string[]
  readonly tokensIn: number
  readonly tokensOut: number
  readonly latencyMs: number
  readonly costUsd: Decimal
}

function usage(calls: readonly LLMCall[]): Usage {
  let cost = new Decimal(0)
  for (const call of calls) cost = cost.plus(call.costUsd)
  return {
    models: [...new Set(calls.map((call) => call.model))],
    tokensIn: calls.reduce((sum, call) => sum + call.tokensIn, 0),
    tokensOut: calls.reduce((sum, call) => sum + call.tokensOut, 0),
    latencyMs: calls.reduce((sum, call) => sum + call.latencyMs, 0),
    costUsd: cost,
  }
}

export class RunRecorder {
  readonly calls: LLMCall[] = []
  readonly path: string[] = []

  record(call: LLMCall): void {
    this.calls.push(call)
  }

  visit(node: string): void {
    this.path.push(node)
  }

  mark(): number {
    return this.calls.length
  }

  since(mark: number): Usage {
    return usage(this.calls.slice(mark))
  }

  totals(): Usage {
    return usage(this.calls)
  }
}
