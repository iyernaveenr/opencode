export * as PtyOsc from "./osc"

// Incremental parser for the shell-integration escape sequences emitted by
// integration.ts: OSC 133 (A/B/C/D), OSC 633;E (command line), OSC 7 (cwd).
// The PTY data stream is observed, never modified; unrecognized sequences pass
// through as output. Sequences may be split across chunks, so an incomplete
// OSC tail is carried into the next push.

export type Event =
  | { readonly type: "prompt-start" }
  | { readonly type: "command-start" }
  | { readonly type: "command-line"; readonly command: string }
  | { readonly type: "pre-exec" }
  | { readonly type: "finished"; readonly exitCode?: number }
  | { readonly type: "cwd"; readonly cwd: string }
  | { readonly type: "output"; readonly data: string }

const ESC = "\x1b"
const BEL = "\x07"
// Cap carried partial sequences so a hostile/broken stream cannot buffer unboundedly.
const CARRY_LIMIT = 4096

function unescapeCommand(value: string) {
  return value.replace(/\\(\\|x3b|x0a|x09)/g, (_, code: string) => {
    if (code === "\\") return "\\"
    if (code === "x3b") return ";"
    if (code === "x0a") return "\n"
    return "\t"
  })
}

function decode(payload: string): Event | undefined {
  if (payload === "133;A") return { type: "prompt-start" }
  if (payload === "133;B") return { type: "command-start" }
  if (payload === "133;C") return { type: "pre-exec" }
  if (payload === "133;D") return { type: "finished" }
  if (payload.startsWith("133;D;")) {
    const code = Number(payload.slice("133;D;".length))
    return { type: "finished", exitCode: Number.isSafeInteger(code) && code >= 0 ? code : undefined }
  }
  if (payload.startsWith("633;E;"))
    return { type: "command-line", command: unescapeCommand(payload.slice("633;E;".length)) }
  if (payload.startsWith("7;file://")) {
    const url = payload.slice("7;".length)
    const path = url.slice("file://".length)
    const slash = path.indexOf("/")
    if (slash === -1) return undefined
    return { type: "cwd", cwd: path.slice(slash) }
  }
  return undefined
}

export function createParser() {
  let carry = ""

  return {
    push(chunk: string): Event[] {
      const events: Event[] = []
      const data = carry + chunk
      carry = ""
      let output = ""
      let index = 0

      while (index < data.length) {
        const esc = data.indexOf(ESC, index)
        if (esc === -1) {
          output += data.slice(index)
          break
        }
        output += data.slice(index, esc)

        if (data[esc + 1] === undefined) {
          carry = data.slice(esc)
          break
        }
        if (data[esc + 1] !== "]") {
          // Not an OSC; pass the ESC through as output and continue after it.
          output += data[esc]
          index = esc + 1
          continue
        }

        // OSC payload runs until BEL or ST (ESC \).
        const bel = data.indexOf(BEL, esc + 2)
        const st = data.indexOf(ESC + "\\", esc + 2)
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (end === -1) {
          const tail = data.slice(esc)
          if (tail.length <= CARRY_LIMIT) carry = tail
          // Oversized partial: drop it as output to bound memory.
          if (tail.length > CARRY_LIMIT) output += tail
          break
        }

        const payload = data.slice(esc + 2, end)
        const event = decode(payload)
        if (event) {
          if (output) {
            events.push({ type: "output", data: output })
            output = ""
          }
          events.push(event)
        }
        if (!event) output += data.slice(esc, end + (data[end] === BEL ? 1 : 2))
        index = end + (data[end] === BEL ? 1 : 2)
      }

      if (output) events.push({ type: "output", data: output })
      return events
    },
  }
}

// Strips ANSI/VT control sequences and carriage returns so stored command output is
// plain text suitable for model consumption.
export function stripControl(data: string) {
  return data
    .replace(/\x1b\[[0-9;:?<=>!]*[a-zA-Z@`~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "")
}
