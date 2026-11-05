import { describe, expect, test } from 'vitest'
import { Decimal, DecimalError } from '../src/decimal.ts'

const d = (value: string | number | bigint) => new Decimal(value)
const CENT = d('0.01')

const THROWS = Symbol('throws')

function outcome(operation: () => Decimal | string): string | typeof THROWS {
  try {
    return operation().toString()
  } catch (error) {
    if (error instanceof DecimalError) return THROWS
    throw error
  }
}

describe('Decimal', () => {
  test.each<[string, () => Decimal | string, string | typeof THROWS]>([
    ["'2' × '100.00'", () => d('2').times(d('100.00')), '200.00'],
    ["'1.005'.quantize('0.01', HALF_UP)", () => d('1.005').quantize(CENT, 'HALF_UP'), '1.01'],
    ["'1.005'.quantize('0.01', HALF_EVEN)", () => d('1.005').quantize(CENT, 'HALF_EVEN'), '1.00'],
    ["'0.125' HALF_EVEN to cents", () => d('0.125').quantize(CENT, 'HALF_EVEN'), '0.12'],
    ["'10' ÷ '4'", () => d('10').div(d('4')), '2.5'],
    ["'1' ÷ '3'", () => d('1').div(d('3')), THROWS],
    ["'-0.50'.abs()", () => d('-0.50').abs(), '0.50'],
    ["'0.00'.toString()", () => d('0.00').toString(), '0.00'],
    ["'0.0000003'.toString() (a cost)", () => d('0.0000003').toString(), '0.0000003'],
    ["toFixed(2, grouped) on '1234567.5'", () => d('1234567.5').toFixed(2, true), '1,234,567.50'],
    ["'abc'", () => d('abc'), THROWS],
  ])('%s', (_name, operation, expected) => {
    expect(outcome(operation)).toBe(expected)
  })

  test.each<[string, () => Decimal | string, string | typeof THROWS]>([
    ["'1.5' + '2.25' keeps the larger scale", () => d('1.5').plus(d('2.25')), '3.75'],
    ["'1.10' - '1.1'", () => d('1.10').minus(d('1.1')), '0.00'],
    ["'0.50'.neg()", () => d('0.50').neg(), '-0.50'],
    ["'-2.5' × '0.4'", () => d('-2.5').times(d('0.4')), '-1.00'],
    ["'2.00' ÷ '1' keeps the dividend's scale", () => d('2.00').div(d('1')), '2.00'],
    ["'23' ÷ '100'", () => d('23').div(d('100')), '0.23'],
    ["'12000' ÷ '100'", () => d('12000').div(d('100')), '120'],
    ["'-7' ÷ '8'", () => d('-7').div(d('8')), '-0.875'],
    ["'1' ÷ '0'", () => d('1').div(d('0')), THROWS],
    ["'-1.005' HALF_UP goes away from zero", () => d('-1.005').quantize(CENT, 'HALF_UP'), '-1.01'],
    ["'-0.125' HALF_EVEN", () => d('-0.125').quantize(CENT, 'HALF_EVEN'), '-0.12'],
    ["'0.135' HALF_EVEN", () => d('0.135').quantize(CENT, 'HALF_EVEN'), '0.14'],
    ["'0.344' HALF_UP", () => d('0.344').quantize(CENT, 'HALF_UP'), '0.34'],
    ["'7' to cents pads", () => d('7').quantize(CENT, 'HALF_UP'), '7.00'],
    ["'2.345'.toFixed(2) rounds half-even", () => d('2.345').toFixed(2), '2.34'],
    ["'2.355'.toFixed(2)", () => d('2.355').toFixed(2), '2.36'],
    [
      "'-1234.5'.toFixed(undefined, grouped)",
      () => d('-1234.5').toFixed(undefined, true),
      '-1,234.5',
    ],
    ["'999.5'.toFixed(0, grouped)", () => d('999.5').toFixed(0, true), '1,000'],
    ['the number 0.1', () => d(0.1), '0.1'],
    ['the number 3e-7', () => d(3e-7), '0.0000003'],
    ['the number 1e21', () => d(1e21), '1000000000000000000000'],
    ['the number -7', () => d(-7), '-7'],
    ['the bigint 100n', () => d(100n), '100'],
    ['NaN', () => d(Number.NaN), THROWS],
    ['Infinity', () => d(Infinity), THROWS],
    ["'1e3'", () => d('1e3'), THROWS],
    ["' 1'", () => d(' 1'), THROWS],
    ["'1.'", () => d('1.'), THROWS],
    ["'1,5'", () => d('1,5'), THROWS],
    ["'-0.00'", () => d('-0.00'), '0.00'],
    ["'+5'", () => d('+5'), '5'],
  ])('%s', (_name, operation, expected) => {
    expect(outcome(operation)).toBe(expected)
  })

  test.each([
    ['2.0', '2', 0],
    ['-1', '0.5', -1],
    ['0.10', '0.09', 1],
    ['-0.00', '0', 0],
    ['-2.5', '-2.49', -1],
  ] as const)('cmp(%s, %s) is %i', (a, b, order) => {
    expect(d(a).cmp(d(b))).toBe(order)
    expect(d(b).cmp(d(a))).toBe(order === 0 ? 0 : -order)
    expect(d(a).equals(d(b))).toBe(order === 0)
    expect(d(a).lte(d(b))).toBe(order <= 0)
  })

  test('isZero ignores the scale and sign', () => {
    expect([d('0.00').isZero(), d('-0').isZero(), d('0.01').isZero()]).toEqual([true, true, false])
  })

  test('key is the same for equal values and differs otherwise', () => {
    expect(d('8.0').key()).toBe(d('8').key())
    expect(d('0.00').key()).toBe(d('0').key())
    expect(d('8.0').key()).not.toBe(d('80').key())
    expect(d('0.23').key()).not.toBe(d('2.3').key())
  })

  test('JSON writes the string with its scale', () => {
    expect(JSON.stringify({ net: d('200.00') })).toBe('{"net":"200.00"}')
  })
})
