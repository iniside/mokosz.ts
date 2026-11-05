// Tax id checksums: Polish NIP and German USt-IdNr. Both take the id as printed: spaces and dashes
// are dropped first; a NIP may carry a printed `PL` prefix, a USt-IdNr must carry its `DE` prefix.
const SEPARATORS = /[\s-]/g
const NIP = /^[0-9]{10}$/
const UST_IDNR = /^DE([0-9]{9})$/
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]

const compact = (value: string): string => value.replace(SEPARATORS, '')

// The NIP check digit of its first nine digits; 10 means that no check digit fits.
export function nipCheckDigit(digits: string): number {
  return NIP_WEIGHTS.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0) % 11
}

// The ISO 7064 Mod 11,10 check digit of the first eight digits of a USt-IdNr.
export function ustIdnrCheckDigit(digits: string): number {
  let product = 10
  for (const digit of digits) {
    const total = (Number(digit) + product) % 10 || 10
    product = (2 * total) % 11
  }
  return (11 - product) % 10
}

export function nipValid(value: string): boolean {
  const compacted = compact(value)
  const nip = compacted.startsWith('PL') ? compacted.slice(2) : compacted
  if (!NIP.test(nip)) return false
  return nipCheckDigit(nip) === Number(nip[9])
}

export function ustIdnrValid(value: string): boolean {
  const match = UST_IDNR.exec(compact(value))
  if (match === null) return false
  const digits = match[1]!
  return ustIdnrCheckDigit(digits.slice(0, 8)) === Number(digits[8])
}
