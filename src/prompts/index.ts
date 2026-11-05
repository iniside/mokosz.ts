import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DIRECTORY = import.meta.dirname

/** Read once per module at import; never on the request path. */
export function load(name: string): string {
  return readFileSync(join(DIRECTORY, `${name}.md`), 'utf8').trim()
}
