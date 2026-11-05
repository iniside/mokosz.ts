import { describe, expect, test } from 'vitest'
import { nipValid, ustIdnrValid } from '../../src/invoices/taxid.ts'

const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]

const weighted = (digits: string): number =>
  NIP_WEIGHTS.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0)

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function nipOracle(digits: string): boolean {
  let total = 0
  for (const [position, weight] of NIP_WEIGHTS.entries()) {
    total += Number(digits[position]) * weight
  }
  const check = total - 11 * Math.floor(total / 11)
  return check < 10 && String(check) === digits.at(-1)
}

function iso7064Mod1110IsValid(digits: string): boolean {
  let remainder = 10
  let s = 0
  for (const digit of digits) {
    s = (remainder + Number(digit)) % 10
    if (s === 0) s = 10
    remainder = (s * 2) % 11
  }
  return s === 1
}

describe('nipValid', () => {
  test.each(['5260250274', '526-025-02-74', 'PL5260250274', 'PL 526 025 02 74', '526 025 02 74'])(
    'a valid NIP passes in every printed form (%s)',
    (nip) => {
      expect(nipValid(nip)).toBe(true)
    },
  )

  test('the NIP case value checks by hand', () => {
    expect(weighted('526025027')).toBe(169)
    expect(weighted('526025027') % 11).toBe(4)
  })

  test('agrees with an independent oracle on random prefixes', () => {
    const next = random(20261103)
    for (let n = 0; n < 2_000; n++) {
      const prefix = String(Math.floor(next() * 1e9)).padStart(9, '0')
      for (const check of DIGITS) {
        expect(nipValid(prefix + check), prefix + check).toBe(nipOracle(prefix + check))
      }
    }
  })

  test.each(DIGITS.filter((d) => d !== '4'))(
    'a NIP with any other check digit is invalid (%s)',
    (last) => {
      expect(nipValid(`526025027${last}`)).toBe(false)
    },
  )

  test('a NIP whose remainder is ten is invalid for every last digit', () => {
    let n = 100_000_000
    while (weighted(String(n)) % 11 !== 10) n++
    const prefix = String(n)
    for (const last of DIGITS) expect(nipValid(prefix + last)).toBe(false)
  })

  test.each([
    '526025027',
    '52602502740',
    '52602502A4',
    'NIP5260250274',
    'DE5260250274',
    '',
    '5260250274PL',
  ])('a malformed NIP is invalid (%j)', (nip) => {
    expect(nipValid(nip)).toBe(false)
  })
})

describe('ustIdnrValid', () => {
  test('the USt-IdNr case value checks by an independent mod 11,10', () => {
    const passing = DIGITS.filter((c) => iso7064Mod1110IsValid(`13669597${c}`))
    expect(passing).toEqual(['6'])
  })

  test('agrees with the independent mod 11,10 on random prefixes', () => {
    const next = random(20261103)
    for (let n = 0; n < 2_000; n++) {
      const prefix = String(Math.floor(next() * 1e8)).padStart(8, '0')
      for (const check of DIGITS) {
        const digits = prefix + check
        expect(ustIdnrValid(`DE${digits}`), digits).toBe(iso7064Mod1110IsValid(digits))
      }
    }
  })

  test.each(['DE136695976', 'DE 136 695 976', 'DE-136-695-976'])('a valid USt-IdNr (%s)', (ust) => {
    expect(ustIdnrValid(ust)).toBe(true)
  })

  test.each(DIGITS.filter((d) => d !== '6'))(
    'a USt-IdNr with any other check digit is invalid (%s)',
    (last) => {
      expect(ustIdnrValid(`DE13669597${last}`)).toBe(false)
    },
  )

  test.each([
    'DE13669597',
    '136695976',
    'DE1366959760',
    'de136695976',
    'PL136695976',
    'DE13669597A',
  ])('a malformed USt-IdNr is invalid (%s)', (ust) => {
    expect(ustIdnrValid(ust)).toBe(false)
  })
})

// SPEC § 1 Invoices: spaces and dashes are removed and a printed PL prefix is stripped before the
// checksum; PL5260250274 sums to 169 (169 mod 11 = 4) and DE136695976 passes MOD 11,10.
describe('tax id case table', () => {
  test.each([
    ['PL5260250274', true, false],
    ['PL5260250275', false, false],
    ['PL526025027', false, false],
    ['DE136695976', false, true],
    ['DE136695977', false, false],
    ['DE13669597', false, false],
    [' PL 526-025-02-74 ', true, false],
    ['\tPL\u00a0526\n025-02-74', true, false],
    [' DE 136-695-976 ', false, true],
    ['PL 5260250274', true, false],
    ['PL-5260250274', true, false],
  ] as const)('%j: NIP %s, USt-IdNr %s', (text, nip, ust) => {
    expect(nipValid(text)).toBe(nip)
    expect(ustIdnrValid(text)).toBe(ust)
  })
})
