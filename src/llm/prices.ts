import { Decimal } from '../decimal.ts'

interface Rates {
  input: string
  output: string
}

interface Price extends Rates {
  /** Both rates change once the prompt has more than `tokens` tokens. */
  above?: Rates & { tokens: number }
}

// USD per token.
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5-5': { input: '0.000002', output: '0.00001' },
  'claude-haiku-5-5': {
    input: '0.0000001',
    output: '0.0000005',
    above: { tokens: 100_000, input: '0.0000005', output: '0.0000025' },
  },
}

export class ModelNotMappedError extends Error {
  override name = 'ModelNotMappedError'
}

/** The exact USD cost of an Anthropic response without cached tokens, without trailing zeros. */
export function completionCost(model: string, tokensIn: number, tokensOut: number): Decimal {
  const price = PRICES[model]
  if (price === undefined) {
    throw new ModelNotMappedError(`no price for model ${model}; add it to src/llm/prices.ts`)
  }
  const rates = price.above !== undefined && tokensIn > price.above.tokens ? price.above : price
  const cost = new Decimal(tokensIn)
    .times(new Decimal(rates.input))
    .plus(new Decimal(tokensOut).times(new Decimal(rates.output)))
  return new Decimal(cost.key())
}

// These models accept temperature 1 only.
export const NO_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
])
