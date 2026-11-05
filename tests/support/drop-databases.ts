// Drops the named databases: node tests/support/drop-databases.ts <server url> <name>...
import { dropDatabase } from './databases.ts'

const [serverUrl, ...names] = process.argv.slice(2)
if (serverUrl === undefined) throw new Error('usage: drop-databases.ts <server url> <name>...')
for (const name of names) await dropDatabase(serverUrl, name)
