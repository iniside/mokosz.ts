// PreToolUse(Bash, PowerShell) guard enforcing two AGENTS.md rules:
//
//   1. Git Safety: never discard/overwrite uncommitted work and never reset past
//      commits you did not make this turn. Blocks the destructive git verbs the
//      rule names (stash, restore, checkout-discard, reset --hard, reset past
//      HEAD~1, clean) plus deleting `.git/index`, also behind git global options
//      (`git -C <path> stash`). Unstaging (`git reset`, `git reset <paths>`) and
//      undoing your own just-made commit (`git reset [--soft] HEAD~1`) stay
//      ALLOWED, as the rule permits them.
//
//   2. Commit Message Format: every `git commit` (each one in a chained command) must carry a
//      `Co-Authored-By: Claude` trailer so authorship is never silently dropped.
//      The subject shape and step suffix are checked by commit-format.ts and
//      violations are DENIED; a subject that cannot be extracted (`-F file`) is
//      left to the git commit-msg hook. `--no-verify`, any accepted abbreviation
//      of it and `-n` are DENIED.
//
// Bash commands are read with POSIX shell quoting, PowerShell commands with
// PowerShell quoting (here-strings, backtick escapes and continuations).
// The hook only ever DENIES; it never approves, so non-git commands and
// safe git flow straight through (exit 0 = defer to normal permission handling).
import { checkSubject, splitLines } from './commit-format.ts'
import { emit, readInput, text } from './io.ts'

type Word = [word: string, dynamic: boolean]
type Commit = [subject: string | null, flags: Set<string>, hasMessage: boolean, segment: string]

const BT = '\x60'
const GIT = String.raw`\b(?i:git(?:\.exe)?)`
const GIT_GLOBALS =
  String.raw`(?:\s+(?:-C\s*\S+|-c\s*\S+|-[pP]\b` +
  String.raw`|--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix|attr-source)\s+[^\s-]\S*` +
  String.raw`|--[\w-]+(?:=\S+)?))*\s+`
const GIT_COMMIT = new RegExp(GIT + GIT_GLOBALS + String.raw`commit\b`, 'g')
const HEREDOC_HEADER = /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n/y
const HEREDOC_SUBST =
  /^\s*\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[^\n]*\n(.*?)\n[ \t]*\2[ \t]*\n?\s*\)\s*$/s
const HEREDOC_MASK = /<<-?\s*['"]?(\w+)['"]?.*?\n\1\b/gs
const BASH_COMMENT = String.raw`|(?:^|(?<=[ \t\r\n;|&()]))#[^\n]*`
const PS_COMMENT = String.raw`|(?:^|(?<=[ \t\r\n;|&(){}]))#[^\n]*`
const BASH_QUOTED = new RegExp(String.raw`\\.|'[^']*'|"(?:\\.|[^"\\])*"` + BASH_COMMENT, 'gs')
const PS_QUOTED = new RegExp(
  String.raw`@'[ \t]*\r?\n(?:.*?\r?\n)?'@|@"[ \t]*\r?\n(?:.*?\r?\n)?"@|\x60.|'(?:''|[^'])*'|"(?:\x60.|""|[^"\x60])*"` +
    String.raw`|<#.*?(?:#>|$)` +
    PS_COMMENT,
  'gs',
)
const DELETE_COMMAND = /(?<![^\s;|&(){}])(?i:rm|del|erase|ri|Remove-Item)(?=[ \t])/g
const GIT_INDEX_PATH = /\.git[/\\]+index(?![\w.])/i
const PS_HERE_HEADER = /@(['"])[ \t]*\r?\n/y
const PS_CONTINUATION = /\x60\r?\n/y
const PS_ESCAPES = new Map([
  ['0', '\0'],
  ['a', '\x07'],
  ['b', '\b'],
  ['e', '\x1b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
])
const VALUE_SHORT = 'mFcCt'
const VALUE_LONG = new Set([
  '--message',
  '--file',
  '--template',
  '--author',
  '--date',
  '--cleanup',
  '--reuse-message',
  '--reedit-message',
  '--pathspec-from-file',
])

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const at = (s: string, i: number): string => s.slice(i, i + 1)
const psEscape = (c: string): string => PS_ESCAPES.get(c) ?? c

function sticky(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i
  return re.exec(s)
}

function blank(match: string): string {
  return match.replace(/[^\n]/g, 'x')
}

function shorten(match: string): string {
  const first = match[0]!
  if ('#<'.includes(first)) return ' '
  if (('\\' + BT).includes(first)) return match
  return "'@".includes(first) ? "''" : '""'
}

function blankQuoted(match: string): string {
  const first = match[0]!
  if ('#<'.includes(first)) return match.replace(/[^\n]/g, ' ')
  return ('\\' + BT).includes(first) ? match : blank(match)
}

export function mask(command: string, powershell: boolean, keepLength: boolean): string {
  let masked: string
  if (powershell) {
    masked = command.replace(PS_QUOTED, keepLength ? blankQuoted : shorten)
  } else {
    masked = command.replace(HEREDOC_MASK, keepLength ? blank : () => '')
    masked = masked.replace(BASH_QUOTED, keepLength ? blankQuoted : shorten)
  }
  const continuation = powershell ? /\x60\r?\n/g : /\\\r?\n/g
  return masked.replace(continuation, (m) => ' '.repeat(m.length))
}

function terminator(heredocId: string, s: string, pos: number): RegExpExecArray | null {
  const re = new RegExp('^[ \\t]*' + escapeRegExp(heredocId) + '[ \\t]*$', 'gm')
  re.lastIndex = pos
  return re.exec(s)
}

function skipSubst(s: string, i: number): number {
  let depth = 1
  while (i < s.length) {
    const header = sticky(HEREDOC_HEADER, s, i)
    if (header) {
      const end = terminator(header[2]!, s, i + header[0].length)
      if (end === null) return s.length
      i = end.index + end[0].length
      continue
    }
    const c = s[i]!
    if (c === "'") {
      const close = s.indexOf("'", i + 1)
      i = close < 0 ? s.length : close + 1
    } else if (c === '"') {
      i = readDouble(s, i + 1)[1]
    } else {
      depth += Number(c === '(') - Number(c === ')')
      i++
      if (depth === 0) return i
    }
  }
  return i
}

function readDouble(s: string, i: number): [string, number] {
  const buf: string[] = []
  while (i < s.length) {
    const c = s[i]!
    if (c === '"') return [buf.join(''), i + 1]
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') {
        i += 2
        continue
      }
      if (('"\\$' + BT).includes(s[i + 1]!)) {
        buf.push(s[i + 1]!)
        i += 2
        continue
      }
    }
    if (c === '$' && at(s, i + 1) === '(') {
      const end = skipSubst(s, i + 2)
      buf.push(s.slice(i, end))
      i = end
      continue
    }
    buf.push(c)
    i++
  }
  return [buf.join(''), i]
}

function readWord(s: string, i: number): [string, number] {
  let out = ''
  const herestring = s[i] === '@' && ["'", '"'].includes(at(s, i + 1))
  if (herestring) i++
  while (i < s.length) {
    const c = s[i]!
    if (' \t\r\n\u00a0;|'.includes(c) || (c === '&' && !['<', '>'].includes(out.slice(-1)))) break
    if (c === '\\') {
      if (at(s, i + 1) === '\n') {
        i += 2
      } else {
        out += at(s, i + 1)
        i += 2
      }
      continue
    }
    if (c === "'" || c === '"') {
      if (c === "'") {
        let close = s.indexOf("'", i + 1)
        close = close < 0 ? s.length : close
        out += s.slice(i + 1, close)
        i = close + 1
      } else {
        const [value, next] = readDouble(s, i + 1)
        out += value
        i = next
      }
      if (herestring && at(s, i) === '@') i++
      continue
    }
    out += c
    i++
  }
  return [out, i]
}

function bashWords(s: string, i: number): [Word[], number] {
  const words: Word[] = []
  const n = s.length
  while (true) {
    while (i < n && ' \t\r\u00a0'.includes(s[i]!)) i++
    if (s.slice(i, i + 2) === '\\\n') {
      i += 2
      continue
    }
    if (i >= n || '\n;|&#'.includes(s[i]!)) break
    const start = i
    const [word, next] = readWord(s, i)
    i = next
    if (i === start) {
      i++
      continue
    }
    words.push([word, false])
  }
  return [words, i]
}

function psSkipSubexpr(s: string, i: number): number {
  let depth = 1
  while (i < s.length) {
    const c = s[i]!
    if (c === BT) {
      i += 2
    } else if (c === "'") {
      const close = s.indexOf("'", i + 1)
      i = close < 0 ? s.length : close + 1
    } else if (c === '"') {
      i = psReadDouble(s, i + 1, true)[1]
    } else {
      depth += Number(c === '(') - Number(c === ')')
      i++
      if (depth === 0) return i
    }
  }
  return i
}

function psReadDouble(s: string, i: number, atStart: boolean): [string, number, boolean] {
  const buf: string[] = []
  let dynamic = false
  const n = s.length
  while (i < n) {
    const c = s[i]!
    if (c === '"') {
      if (at(s, i + 1) === '"') {
        buf.push('"')
        i += 2
        continue
      }
      return [buf.join(''), i + 1, dynamic]
    }
    if (c === BT && i + 1 < n) {
      buf.push(psEscape(s[i + 1]!))
      i += 2
      continue
    }
    if (c === '$' && atStart && !buf.join('').trim()) dynamic = true
    if (c === '$' && at(s, i + 1) === '(') {
      const end = psSkipSubexpr(s, i + 2)
      buf.push(s.slice(i, end))
      i = end
      continue
    }
    buf.push(c)
    i++
  }
  return [buf.join(''), i, dynamic]
}

function psReadHere(
  s: string,
  header: RegExpExecArray,
  atStart: boolean,
): [string, number, boolean] {
  const quote = header[1]!
  const headerEnd = header.index + header[0].length
  const closing = new RegExp('^' + escapeRegExp(quote) + '@', 'gm')
  closing.lastIndex = headerEnd
  const end = closing.exec(s)
  const stop = end ? end.index : s.length
  let body = s.slice(headerEnd, stop)
  if (end) {
    if (body.endsWith('\n')) body = body.slice(0, -1)
    if (body.endsWith('\r')) body = body.slice(0, -1)
  }
  const after = end ? end.index + end[0].length : s.length
  if (quote === "'") return [body, after, false]
  const buf: string[] = []
  let dynamic = false
  let i = 0
  while (i < body.length) {
    const c = body[i]!
    if (c === BT && i + 1 < body.length) {
      buf.push(psEscape(body[i + 1]!))
      i += 2
      continue
    }
    if (c === '$' && atStart && !buf.join('').trim()) dynamic = true
    buf.push(c)
    i++
  }
  return [buf.join(''), after, dynamic]
}

function psReadWord(s: string, i: number): [string, boolean, number] {
  let out = ''
  let dynamic = false
  let depth = 0
  const n = s.length
  while (i < n) {
    const c = s[i]!
    if (
      ' \t\r\n\u00a0;|'.includes(c) ||
      (c === '&' && out.slice(-1) !== '>') ||
      (c === ')' && depth === 0)
    )
      break
    depth += Number(c === '(') - Number(c === ')')
    const atStart = !out.trim()
    if (c === BT) {
      if (['\r', '\n', ''].includes(at(s, i + 1))) break
      out += psEscape(s[i + 1]!)
      i += 2
      continue
    }
    const header = out ? null : sticky(PS_HERE_HEADER, s, i)
    if (header) {
      const [value, next, hereDynamic] = psReadHere(s, header, atStart)
      out += value
      i = next
      dynamic = dynamic || hereDynamic
      continue
    }
    if (c === "'") {
      const buf: string[] = []
      let j = i + 1
      while (j < n) {
        if (s[j] === "'") {
          if (at(s, j + 1) === "'") {
            buf.push("'")
            j += 2
            continue
          }
          break
        }
        buf.push(s[j]!)
        j++
      }
      out += buf.join('')
      i = j + 1
      continue
    }
    if (c === '"') {
      const [value, next, doubleDynamic] = psReadDouble(s, i + 1, atStart)
      out += value
      i = next
      dynamic = dynamic || doubleDynamic
      continue
    }
    if (c === '$') {
      dynamic = dynamic || atStart
      if (at(s, i + 1) === '(') {
        const end = psSkipSubexpr(s, i + 2)
        out += s.slice(i, end)
        i = end
        continue
      }
    }
    out += c
    i++
  }
  return [out, dynamic, i]
}

function psWords(s: string, i: number): [Word[], number] {
  const words: Word[] = []
  const n = s.length
  while (true) {
    while (i < n && ' \t\r\u00a0'.includes(s[i]!)) i++
    const continuation = sticky(PS_CONTINUATION, s, i)
    if (continuation) {
      i += continuation[0].length
      continue
    }
    if (s.startsWith('<#', i)) {
      const close = s.indexOf('#>', i + 2)
      i = close < 0 ? n : close + 2
      continue
    }
    if (i >= n || '\n;|&)}#'.includes(s[i]!)) break
    const start = i
    const [word, dynamic, next] = psReadWord(s, i)
    i = next
    if (i === start) {
      i++
      continue
    }
    words.push([word, dynamic])
  }
  return [words, i]
}

const words = (powershell: boolean, s: string, i: number): [Word[], number] =>
  powershell ? psWords(s, i) : bashWords(s, i)

export function parseCommits(command: string, powershell = false): Commit[] {
  const matches = [...mask(command, powershell, true).matchAll(GIT_COMMIT)]
  const bounds = [...matches.slice(1).map((match) => match.index), command.length]
  return matches.map((found, k) =>
    parseCommit(command, powershell, found.index, found.index + found[0].length, bounds[k]!),
  )
}

function parseCommit(
  command: string,
  powershell: boolean,
  foundStart: number,
  foundEnd: number,
  stop: number,
): Commit {
  const [parsed, end] = words(powershell, command, foundEnd)
  const flags = new Set<string>()
  let first: [kind: string, value: string, dynamic: boolean] | null = null
  let hasMessage = false
  let expect: string | null = null
  let heredocWait = false
  let heredocId: string | null = null
  let positional = false

  const take = (kind: string, value: string, dynamic: boolean): void => {
    hasMessage = hasMessage || kind === 'm'
    if (first === null && (kind === 'm' || kind === 'F')) first = [kind, value, dynamic]
  }
  const kindOf = (name: string, message: string, file: string): string =>
    name === message ? 'm' : name === file ? 'F' : 'o'

  for (const [word, dynamic] of parsed) {
    if (expect) {
      take(expect, word, dynamic)
      expect = null
    } else if (heredocWait) {
      heredocId = word
      heredocWait = false
    } else if (!powershell && word.startsWith('<<') && !word.startsWith('<<<')) {
      const ident = word.slice(2).replace(/^-+/, '')
      if (ident) heredocId = ident
      else heredocWait = true
    } else if (positional || !word.startsWith('-') || word === '-') {
      continue
    } else if (word === '--') {
      positional = true
    } else if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      const name = eq < 0 ? word : word.slice(0, eq)
      flags.add(name)
      if (VALUE_LONG.has(name)) {
        const kind = kindOf(name, '--message', '--file')
        if (eq >= 0) take(kind, word.slice(eq + 1), dynamic)
        else expect = kind
      }
    } else {
      const letters = word.slice(1)
      for (let index = 0; index < letters.length; index++) {
        const ch = letters[index]!
        if (VALUE_SHORT.includes(ch)) {
          const kind = kindOf(ch, 'm', 'F')
          const rest = letters.slice(index + 1)
          if (rest) take(kind, rest, dynamic)
          else expect = kind
          break
        }
        flags.add('-' + ch)
        if ('uS'.includes(ch)) break
      }
    }
  }

  const head = first as [string, string, boolean] | null
  let message: string | null = null
  if (head !== null && head[0] === 'm') {
    message = head[1]
    if (powershell) {
      message = head[2] ? null : message
    } else {
      const heredoc = HEREDOC_SUBST.exec(message)
      if (heredoc) message = heredoc[3]!
      else if (message.trimStart().startsWith('$')) message = null
    }
  } else if (head !== null && head[0] === 'F' && head[1] === '-' && heredocId) {
    const newline = command.indexOf('\n', end)
    const close = newline >= 0 ? terminator(heredocId, command, newline + 1) : null
    message = close ? command.slice(newline + 1, close.index) : null
  }
  let subject: string | null = null
  if (message !== null)
    subject =
      splitLines(message)
        .map((line) => line.trim())
        .find(Boolean) ?? null
  const variableMessage = head !== null && head[0] === 'm' && message === null
  return [subject, flags, hasMessage, command.slice(variableMessage ? 0 : foundStart, stop)]
}

function deletesGitIndex(command: string, powershell: boolean): boolean {
  const code = mask(command, powershell, true)
  let pos = 0
  while (true) {
    DELETE_COMMAND.lastIndex = pos
    const found = DELETE_COMMAND.exec(code)
    if (found === null) return false
    const foundEnd = found.index + found[0].length
    const [parsed, end] = words(powershell, command, foundEnd)
    if (parsed.some(([word]) => GIT_INDEX_PATH.test(word))) return true
    pos = Math.max(end, foundEnd)
  }
}

function deny(reason: string): never {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
  process.exit(0)
}

const gitVerb = (verb: string, rest = ''): RegExp =>
  new RegExp(GIT + GIT_GLOBALS + verb + String.raw`\b` + rest, 'g')
const found = (re: RegExp, s: string): boolean => !s.matchAll(re).next().done

const GIT_STASH = gitVerb('stash', String.raw`(?:\s+(\S+))?`)
const GIT_RESTORE = gitVerb('restore')
const GIT_CLEAN = gitVerb('clean')
const GIT_CHECKOUT = gitVerb('checkout', '([^|;&]*)')
const GIT_SWITCH = gitVerb('switch', '([^|;&]*)')
const GIT_RESET = gitVerb('reset', '([^|;&]*)')
const FORCE_FLAG = /\s(?:-f|--force|--discard-changes)\b/
// HEAD~2+, @~2+, HEAD^^, HEAD^2 (second parent); HEAD~1 / HEAD^ stay allowed.
const RESET_PAST_ONE = /(?:HEAD|@)(?:~(?:[2-9]|\d{2,})\b|\^\^|\^[2-9])/
const PREFIX = 'AGENTS.md Git Safety: '

function main(): void {
  const data = readInput()
  if (data === null) return
  // eslint-disable-next-line no-control-regex
  const command = text(data.tool_input?.command).replace(/[\x85\x1c-\x1f]/g, '\u00a0')
  if (!command.trim()) return
  const powershell = data.tool_name === 'PowerShell'

  // Destructive checks scan COMMAND VERBS only — blank out string/here-doc data
  // first so a commit message that merely *describes* a banned verb (e.g. the
  // text "rm .git/index" inside `-m '...'` or a `git commit -F - <<EOF` body)
  // doesn't trip the guard. The trailer check below deliberately scans the
  // original `command` (it needs the message body).
  const codeOnly = mask(command, powershell, false)
  const norm = codeOnly
    .replace(/\n/g, ' ; ')
    .replace(/[ \t\r]+/g, ' ')
    .trim()

  // --- rm .git/index (but NOT .git/index.lock, which is a safe stale-lock cleanup) ---
  if (
    /\b(?:rm|del|erase|ri|Remove-Item)\b[^|;&]*\.git[/\\]+index(?!\.lock)(\b|$|['"\s])/i.test(
      norm,
    ) ||
    deletesGitIndex(command, powershell)
  ) {
    deny(
      PREFIX +
        'never hand-edit git internals (`rm .git/index`). ' +
        'Removing the stale `.git/index.lock` is fine; deleting the index itself is not.',
    )
  }

  // --- git stash (push/save/bare); list/show/diff are read-only and allowed ---
  for (const stash of norm.matchAll(GIT_STASH)) {
    if (!/^(?:list|show|diff)\b/.test(stash[1] ?? '')) {
      deny(
        PREFIX +
          'never `git stash` — it hides uncommitted work and is easy to lose. ' +
          'To inspect old contents use `git show <sha>:<path>`.',
      )
    }
  }

  // --- git restore (any form discards worktree/staging) ---
  if (found(GIT_RESTORE, norm)) {
    deny(
      PREFIX +
        'never `git restore` — it discards working-tree changes. ' +
        'Use `git show <sha>:<path>` to inspect old contents.',
    )
  }

  // --- git clean (deletes untracked files) ---
  if (found(GIT_CLEAN, norm)) {
    deny(PREFIX + 'never `git clean` — it deletes untracked files, which may be work in progress.')
  }

  // --- git checkout that discards files (`-- <path>`, `.`, `HEAD -- ...`, `-f`) ---
  // Branch/commit checkout (`git checkout main`) is allowed.
  for (const checkout of norm.matchAll(GIT_CHECKOUT)) {
    const rest = checkout[1]!
    if (
      /\s--(?:\s|$)/.test(rest) ||
      /^\s+\.(?:\s|$)/.test(rest) ||
      /^\s+HEAD\b/.test(rest) ||
      FORCE_FLAG.test(rest)
    ) {
      deny(
        PREFIX +
          'never `git checkout -- <file>` / `git checkout .` / `git checkout -f` — ' +
          'it overwrites uncommitted changes. Use `git show <sha>:<path>` to inspect old contents.',
      )
    }
  }

  // --- git switch -f / --discard-changes (plain `git switch <branch>` is allowed) ---
  for (const change of norm.matchAll(GIT_SWITCH)) {
    if (FORCE_FLAG.test(change[1]!)) {
      deny(
        PREFIX +
          'never `git switch -f` / `--discard-changes` — it throws away uncommitted changes.',
      )
    }
  }

  // --- git reset: block --hard, and any reset past HEAD~1 / to a SHA. ---
  // Allowed: bare `git reset`, `git reset <paths>` (unstage),
  //          `git reset [--soft] HEAD~1` (undo own just-made commit).
  // Known limit: a reset to a branch or remote ref (`git reset origin/main`) cannot be
  // told apart from `git reset <path>` by text alone, so it is not caught here.
  for (const reset of norm.matchAll(GIT_RESET)) {
    const rest = reset[1]!
    if (/--hard\b/.test(rest))
      deny(PREFIX + 'never `git reset --hard` — it discards uncommitted changes.')
    if (RESET_PAST_ONE.test(rest) || /^(\s+--(soft|mixed|hard))?\s+[0-9a-f]{7,40}\b/.test(rest)) {
      deny(
        PREFIX +
          'never `git reset` past a commit you did not make this turn. ' +
          'Only unstaging (`git reset [<paths>]`) or `git reset [--soft] HEAD~1` ' +
          'for a commit you made this turn is allowed.',
      )
    }
  }

  const commits = parseCommits(command, powershell)
  commits.forEach(([subject, flags, hasMessage, segment], index) => {
    const which =
      commits.length > 1 ? ` (git commit ${index + 1} of ${commits.length} in the command)` : ''

    if (
      flags.has('-n') ||
      [...flags].some((flag) => flag.startsWith('--no-v') && '--no-verify'.startsWith(flag))
    ) {
      deny(
        'AGENTS.md Commit Message Format' +
          which +
          ': never skip the commit-msg ' +
          'hook (`git commit --no-verify`, an abbreviation such as `--no-verif`, or `-n`). The ' +
          'commit subject format is blocking for every committer; fix the subject instead.',
      )
    }

    // Messages from `-F <file>` are invisible here and left to the git commit-msg hook.
    if (!flags.has('--amend') && !flags.has('--no-edit')) {
      const hasMessageFlag =
        hasMessage || segment.includes('<<') || segment.includes('Co-Authored-By')
      if (hasMessageFlag && !/Co-Authored-By:\s*Claude/.test(segment)) {
        deny(
          'AGENTS.md Commit Message Format' +
            which +
            ': every commit must end ' +
            'with a `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer so ' +
            'authorship is never silently dropped. Add the trailer and retry.',
        )
      }
    }

    if (subject !== null) {
      const message = checkSubject(subject)
      if (message !== null) deny('AGENTS.md Commit Message Format' + which + ': ' + message)
    }
  })
}

main()
