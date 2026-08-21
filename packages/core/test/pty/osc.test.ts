import { describe, expect, test } from "bun:test"
import { PtyOsc } from "@opencode-ai/core/pty/osc"

const BEL = "\x07"
const osc = (payload: string) => `\x1b]${payload}${BEL}`

describe("PtyOsc parser", () => {
  test("parses the full command lifecycle", () => {
    const parser = PtyOsc.createParser()
    const events = parser.push(
      osc("133;A") +
        osc("7;file://host/home/user") +
        "prompt$ " +
        osc("133;B") +
        osc("633;E;ls -la") +
        osc("133;C") +
        "total 0\nfile\n" +
        osc("133;D;0"),
    )
    expect(events).toEqual([
      { type: "prompt-start" },
      { type: "cwd", cwd: "/home/user" },
      { type: "output", data: "prompt$ " },
      { type: "command-start" },
      { type: "command-line", command: "ls -la" },
      { type: "pre-exec" },
      { type: "output", data: "total 0\nfile\n" },
      { type: "finished", exitCode: 0 },
    ])
  })

  test("parses exit codes and bare D", () => {
    const parser = PtyOsc.createParser()
    expect(parser.push(osc("133;D;127"))).toEqual([{ type: "finished", exitCode: 127 }])
    expect(parser.push(osc("133;D"))).toEqual([{ type: "finished" }])
  })

  test("unescapes 633;E command lines", () => {
    const parser = PtyOsc.createParser()
    expect(parser.push(osc("633;E;echo \\x3b done\\\\end"))).toEqual([
      { type: "command-line", command: "echo ; done\\end" },
    ])
  })

  test("handles sequences split across chunk boundaries", () => {
    const parser = PtyOsc.createParser()
    const whole = "before" + osc("133;D;1") + "after"
    for (let split = 7; split < whole.length - 3; split++) {
      const fresh = PtyOsc.createParser()
      const events = [...fresh.push(whole.slice(0, split)), ...fresh.push(whole.slice(split))]
      const finished = events.filter((event) => event.type === "finished")
      const output = events
        .filter((event) => event.type === "output")
        .map((event) => (event as { data: string }).data)
        .join("")
      expect(finished).toEqual([{ type: "finished", exitCode: 1 }])
      expect(output).toBe("beforeafter")
    }
    expect(parser.push("noop")).toEqual([{ type: "output", data: "noop" }])
  })

  test("passes unknown sequences through as output", () => {
    const parser = PtyOsc.createParser()
    const events = parser.push(osc("0;window title") + "text")
    expect(events).toEqual([{ type: "output", data: osc("0;window title") + "text" }])
  })

  test("ST-terminated sequences parse too", () => {
    const parser = PtyOsc.createParser()
    expect(parser.push("\x1b]133;C\x1b\\out")).toEqual([{ type: "pre-exec" }, { type: "output", data: "out" }])
  })

  test("stripControl removes ANSI noise and carriage returns", () => {
    expect(PtyOsc.stripControl("\x1b[1;32mgreen\x1b[0m\r\nline\x1b]0;title\x07")).toBe("green\nline")
  })
})
