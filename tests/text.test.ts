import { oneLine } from '../src/text.ts'
import { describe, expect, test } from './support/harness.ts'

describe('oneLine', () => {
  test.for([
    ['  a \n\t b c  ', 'a b c'],
    ['', ''],
    [' \n ', ''],
    ['x​y', 'x​y'],
  ] as const)('%j becomes %j', ([text, expected]) => {
    expect(oneLine(text)).toBe(expected)
  })
})
