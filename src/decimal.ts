// Exact decimal arithmetic for money and costs (decision 0013): a bigint count of units at a fixed
// scale. Results keep their scale ("2" × "100.00" is "200.00"), and nothing is rounded except by
// `quantize` and `toFixed`.

export class DecimalError extends Error {
  override name = 'DecimalError'
}

type Rounding = 'HALF_UP' | 'HALF_EVEN'

const TEXT = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/
const NUMBER_TEXT = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$/

const UNITS = Symbol('units')

const pow10 = (n: number): bigint => 10n ** BigInt(n)
const abs = (n: bigint): bigint => (n < 0n ? -n : n)

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b]
  return a
}

function parse(value: string | number | bigint): [bigint, number] {
  if (typeof value === 'bigint') return [value, 0]
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DecimalError(`${value} is not a finite number`)
    const match = NUMBER_TEXT.exec(String(value))!
    const [, sign = '', whole = '', fraction = '', power = '0'] = match
    const units = BigInt(sign + whole + fraction)
    const scale = fraction.length - Number(power)
    return scale >= 0 ? [units, scale] : [units * pow10(-scale), 0]
  }
  const match = TEXT.exec(value)
  if (match === null) throw new DecimalError(`${JSON.stringify(value)} is not a decimal number`)
  const [, sign = '', whole = '', fraction = ''] = match
  return [BigInt(sign + whole + fraction), fraction.length]
}

export class Decimal {
  readonly units: bigint
  readonly scale: number

  /** A string in plain notation ("-1234.50"), a finite number or a bigint. */
  constructor(value: string | number | bigint | { readonly [UNITS]: [bigint, number] }) {
    ;[this.units, this.scale] = typeof value === 'object' ? value[UNITS] : parse(value)
  }

  static #of(units: bigint, scale: number): Decimal {
    return new Decimal({ [UNITS]: [units, scale] })
  }

  #at(scale: number): bigint {
    return this.units * pow10(scale - this.scale)
  }

  isZero(): boolean {
    return this.units === 0n
  }

  plus(other: Decimal): Decimal {
    const scale = Math.max(this.scale, other.scale)
    return Decimal.#of(this.#at(scale) + other.#at(scale), scale)
  }

  minus(other: Decimal): Decimal {
    return this.plus(other.neg())
  }

  times(other: Decimal): Decimal {
    return Decimal.#of(this.units * other.units, this.scale + other.scale)
  }

  /** The exact quotient, at no less than the dividend's scale minus the divisor's. */
  div(other: Decimal): Decimal {
    if (other.isZero()) throw new DecimalError(`${this.toString()} / 0`)
    let numerator = this.units * pow10(other.scale)
    let denominator = other.units * pow10(this.scale)
    if (denominator < 0n) [numerator, denominator] = [-numerator, -denominator]
    const common = gcd(abs(numerator), denominator)
    numerator /= common
    denominator /= common
    let rest = denominator
    let twos = 0
    let fives = 0
    while (rest % 2n === 0n) [rest, twos] = [rest / 2n, twos + 1]
    while (rest % 5n === 0n) [rest, fives] = [rest / 5n, fives + 1]
    if (rest !== 1n) {
      throw new DecimalError(`${this.toString()} / ${other.toString()} does not terminate`)
    }
    const digits = Math.max(twos, fives)
    const exact = Decimal.#of(numerator * (pow10(digits) / denominator), digits)
    const scale = Math.max(digits, this.scale - other.scale)
    return Decimal.#of(exact.#at(scale), scale)
  }

  neg(): Decimal {
    return Decimal.#of(-this.units, this.scale)
  }

  abs(): Decimal {
    return Decimal.#of(abs(this.units), this.scale)
  }

  /** The value at `exp`'s scale; a dropped half goes away from zero (HALF_UP) or to even. */
  quantize(exp: Decimal, rounding: Rounding): Decimal {
    return this.#round(exp.scale, rounding)
  }

  #round(scale: number, rounding: Rounding): Decimal {
    if (scale >= this.scale) return Decimal.#of(this.#at(scale), scale)
    const unit = pow10(this.scale - scale)
    const magnitude = abs(this.units)
    let kept = magnitude / unit
    const rest = (magnitude % unit) * 2n
    if (rest > unit || (rest === unit && (rounding === 'HALF_UP' || kept % 2n === 1n))) kept += 1n
    return Decimal.#of(this.units < 0n ? -kept : kept, scale)
  }

  cmp(other: Decimal): -1 | 0 | 1 {
    const scale = Math.max(this.scale, other.scale)
    const [a, b] = [this.#at(scale), other.#at(scale)]
    return a < b ? -1 : a > b ? 1 : 0
  }

  equals(other: Decimal): boolean {
    return this.cmp(other) === 0
  }

  lte(other: Decimal): boolean {
    return this.cmp(other) <= 0
  }

  /** The same string for equal values ("8.0" and "8"). */
  key(): string {
    let [units, scale] = [this.units, this.scale]
    while (scale > 0 && units % 10n === 0n) [units, scale] = [units / 10n, scale - 1]
    return Decimal.#of(units, scale).toString()
  }

  toString(): string {
    return this.toFixed()
  }

  /** Plain notation, rounded half-even to `places` when given; `grouped` adds thousands commas. */
  toFixed(places?: number, grouped = false): string {
    const value = places === undefined ? this : this.#round(places, 'HALF_EVEN')
    const digits = abs(value.units)
      .toString()
      .padStart(value.scale + 1, '0')
    let whole = digits.slice(0, digits.length - value.scale)
    const fraction = value.scale > 0 ? `.${digits.slice(-value.scale)}` : ''
    if (grouped) whole = whole.replace(/\B(?=(?:[0-9]{3})+$)/g, ',')
    return `${value.units < 0n ? '-' : ''}${whole}${fraction}`
  }

  toJSON(): string {
    return this.toString()
  }
}
