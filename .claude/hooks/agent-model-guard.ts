// PreToolUse (Task, Agent): deny a subagent call that does not name its model.
// CLAUDE.md Dispatch lanes: every Agent call sets `model` explicitly, so lanes and
// review tiers are chosen on purpose, never inherited by accident.
import { emit, readInput } from './io.ts'

const REASON =
  'CLAUDE.md Dispatch lanes: every Agent call must set model explicitly (sonnet for ' +
  '[sonnet] and test work, opus for [opus] steps, reviewer >= author tier). ' +
  'Add the model field and retry.'

const data = readInput()
const model = data?.tool_input?.model
if (data !== null && !(model && String(model).trim())) {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  })
}
