import { spawnSync } from 'node:child_process'

/** A failure the CLI reports as one message on stderr and exit code 1. */
export class CommandError extends Error {
  override name = 'CommandError'
}

export interface CommandResult {
  status: number
  stdout: string
  stderr: string
}

export function runCommand(args: string[], cwd?: string): CommandResult {
  const result = spawnSync(args[0]!, args.slice(1), { cwd, encoding: 'utf8' })
  if (result.error !== undefined) {
    return { status: 127, stdout: '', stderr: `${args[0]}: ${result.error.message}` }
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

export function repoRoot(command: string, run: typeof runCommand = runCommand): string {
  const toplevel = run(['git', 'rev-parse', '--show-toplevel'])
  if (toplevel.status !== 0) {
    throw new CommandError(`Not inside a git clone: run mokosz ${command} from the repository`)
  }
  return toplevel.stdout.trim()
}
