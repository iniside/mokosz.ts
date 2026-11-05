// PreToolUse (ExitPlanMode): add the plan finalization checklist from
// docs/reference/plan-writing.md to the context. Never blocks.
import { emit, readInput } from './io.ts'

const CHECKLIST =
  'PLAN CHECKLIST (docs/reference/plan-writing.md): 1) the plan was reviewed by a ' +
  'hostile-reviewer subagent at >= the session model tier; 2) every step has what / ' +
  'why now / how / validation / lane; 3) after approval, copy the plan to docs/plans/ ' +
  'and commit it before any code.'

readInput()
emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: CHECKLIST } })
