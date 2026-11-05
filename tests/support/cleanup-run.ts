// Runs a test directory with the app's global setup and harness, cancels the run when a test
// named "c interrupted" starts (the first Ctrl+C of a terminal run), and prints the outcome.
import { resolve } from 'node:path'
import { startVitest, type Reporter, type TestModule, type Vitest } from 'vitest/node'

const [root] = process.argv.slice(2)
if (root === undefined) throw new Error('usage: cleanup-run.ts <dir>')

let vitest: Vitest | null = null
let summary: unknown = null

const reporter: Reporter = {
  onInit(ctx) {
    vitest = ctx
  },
  onTestCaseReady(testCase) {
    if (testCase.name === 'c interrupted') {
      setTimeout(() => void vitest?.cancelCurrentRun('keyboard-input'), 500)
    }
  },
  onTestRunEnd(modules: ReadonlyArray<TestModule>, _errors, reason) {
    const tests = modules.flatMap((module) => [...module.children.allTests()])
    summary = {
      reason,
      tests: Object.fromEntries(
        tests.map((test) => {
          const result = test.result()
          const errors = 'errors' in result && result.errors ? result.errors : []
          return [test.name, { state: result.state, errors: errors.map((error) => error.message) }]
        }),
      ),
    }
  },
}

const ctx = await startVitest(
  'test',
  [],
  { root, watch: false, config: false },
  {
    test: {
      include: ['*.test.ts'],
      globalSetup: [resolve(import.meta.dirname, 'global-setup.ts')],
      reporters: ['default', reporter],
    },
  },
)
await ctx.close()
process.stdout.write(`\nSUMMARY ${JSON.stringify(summary)}\n`)
process.exitCode = 0
