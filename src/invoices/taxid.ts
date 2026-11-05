// Tax id checksums: Polish NIP and German USt-IdNr. Both take the id as printed: spaces and dashes
// are dropped first; a NIP may carry a printed `PL` prefix, a USt-IdNr must carry its `DE` prefix.
const SEPARATORS = /[\s-]/g
const NIP = /^[0-9]{10}$/
const UST_IDNR = /^DE([0-9]{9})$/
const NIP_WEIGHTS = [6, 5, 7, 2, 3, 4, 5, 6, 7]

const compact = (value: string): string => value.replace(SEPARATORS, '')

export function nipValid(value: string): boolean {
  const compacted = compact(value)
  const nip = compacted.startsWith('PL') ? compacted.slice(2) : compacted
  if (!NIP.test(nip)) return false
  const weighted = NIP_WEIGHTS.reduce((sum, weight, i) => sum + weight * Number(nip[i]), 0)
  return weighted % 11 === Number(nip[9])
}

export function ustIdnrValid(value: string): boolean {
  const match = UST_IDNR.exec(compact(value))
  if (match === null) return false
  const digits = match[1]!
  let product = 10
  for (const digit of digits.slice(0, 8)) {
    const total = (Number(digit) + product) % 10 || 10
    product = (2 * total) % 11
  }
  return (11 - product) % 10 === Number(digits[8])
}
