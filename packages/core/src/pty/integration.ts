export * as PtyIntegration from "./integration"

import path from "path"
import os from "os"
import { promises as fs } from "fs"

// Bash shell integration: emits OSC 133 lifecycle markers plus a VS Code-style
// OSC 633;E carrying the exact command line. Injected via --rcfile (which
// replaces ~/.bashrc, so the script sources it first). Terminals ignore the
// unknown sequences; the capture parser consumes them.
const BASH_SCRIPT = `# opencode shell integration (generated; do not edit)
if [ -f ~/.bashrc ]; then . ~/.bashrc; fi
__oc_esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/;/\\\\x3b/g' | tr '\\n' ' '; }
# Typed command line from history (pre-alias-expansion); BASH_COMMAND is post-expansion.
__oc_histline() { HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed '1 s/^ *[0-9][0-9]*[* ] //'; }
__oc_prev_hist=""
__oc_state=0
__oc_preexec() {
  [ "$__oc_state" = 1 ] || return 0
  case "$BASH_COMMAND" in __oc_*) return 0 ;; esac
  [ -n "$COMP_LINE" ] && return 0
  __oc_state=2
  local __oc_cmd_line
  __oc_cmd_line=$(__oc_histline)
  # History skipped the entry (HISTCONTROL ignorespace/ignoredups): fall back to expanded text.
  [ "$__oc_cmd_line" = "$__oc_prev_hist" ] && __oc_cmd_line="$BASH_COMMAND"
  printf '\\033]633;E;%s\\007' "$(__oc_esc "$__oc_cmd_line")"
  printf '\\033]133;C\\007'
}
__oc_precmd() {
  local __oc_st=$?
  [ "$__oc_state" = 2 ] && printf '\\033]133;D;%s\\007' "$__oc_st"
  __oc_state=0
  printf '\\033]133;A\\007'
  printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "$PWD"
  __oc_prev_hist=$(__oc_histline)
  __oc_state=1
}
trap '__oc_preexec' DEBUG
PROMPT_COMMAND="__oc_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
PS1="\${PS1}\\[\\033]133;B\\007\\]"
export OPENCODE_SHELL_INTEGRATION=1
`

let scriptPath: string | undefined

async function ensureScript() {
  if (scriptPath) return scriptPath
  const dir = path.join(os.tmpdir(), "opencode-shell-integration")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, "integration.bash")
  await fs.writeFile(file, BASH_SCRIPT)
  scriptPath = file
  return file
}

export type Setup = {
  readonly args: string[]
  readonly env: Record<string, string>
}

// Returns adjusted spawn args for shells we can integrate, or undefined to spawn untouched.
// bash only for now: --rcfile is ignored by login shells, so the -l flag is dropped and the
// script sources ~/.bashrc itself.
export async function setup(command: string, args: string[]): Promise<Setup | undefined> {
  const name = path.basename(command).toLowerCase()
  if (name !== "bash") return undefined
  const file = await ensureScript()
  return {
    args: ["--rcfile", file, ...args.filter((arg) => arg !== "-l")],
    env: { OPENCODE_SHELL_INTEGRATION: "1" },
  }
}
