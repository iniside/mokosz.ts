// Runs one cloud router call in a process whose cwd holds the .env file under test.
import { z } from 'zod'
import { nodeAgent, structured } from '../../src/llm/models.ts'
import { loadProfile } from '../../src/llm/profiles.ts'
import { RunRecorder } from '../../src/llm/recorder.ts'

const Route = z.object({ lang: z.string(), article: z.int() })
const result = await structured(
  nodeAgent('router', 'Route.'),
  [{ role: 'user', content: 'Art. 14?' }],
  Route,
  await loadProfile('cloud-claude'),
  new RunRecorder(),
)
process.stdout.write(JSON.stringify(result.parsed))
