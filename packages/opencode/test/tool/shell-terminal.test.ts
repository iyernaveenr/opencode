import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { ShellTool } from "../../src/tool/shell"
import { SessionID, MessageID } from "../../src/session/schema"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Plugin } from "../../src/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { Tool } from "@/tool/tool"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      PtyCapture.node,
    ]),
  ),
)

const run = Effect.fn("ShellTerminalTest.run")(function* (params: { command: string; timeout?: number }) {
  const info = yield* ShellTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

// Simulates an integration-enabled terminal: typed commands produce capture
// records, Ctrl+C finishes the active command with exit 130.
const fakeTerminal = Effect.fn("ShellTerminalTest.fakeTerminal")(function* (opts?: { finish?: boolean }) {
  const capture = yield* PtyCapture.Service
  const ptyID = PtyID.ascending()
  let active: string | undefined
  yield* capture.registerTerminal(ctx.sessionID, {
    ptyID,
    write: (data) => {
      void (async () => {
        if (data === "\x03") {
          if (active) await Effect.runPromise(capture.finish(active, 130))
          active = undefined
          return
        }
        const command = data.replace(/\r$/, "")
        const begun = await Effect.runPromise(
          capture.begin({ ptyID, sessionID: ctx.sessionID, terminalTitle: "Terminal 1", command, cwd: "/tmp" }),
        )
        active = begun.id
        await Effect.runPromise(capture.append(begun.id, `ran:${command}\n`))
        if (opts?.finish === false) return
        await Effect.runPromise(capture.finish(begun.id, 0))
        active = undefined
      })()
    },
  })
  return ptyID
})

describe("tool.shell terminal mode", () => {
  it.instance(
    "runs the command in the session terminal when visible",
    () =>
      Effect.gen(function* () {
        yield* fakeTerminal()
        const result = yield* run({ command: "echo hi" })
        expect(result.output).toContain("ran:echo hi")
        expect(result.output).toContain("session terminal")
        expect(result.metadata.exit).toBe(0)
      }),
    { config: { shell_in_terminal: "visible" } },
  )

  it.instance(
    "falls back to a subprocess when no terminal exists",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ command: "echo solo-proc" })
        expect(result.output).toContain("solo-proc")
        expect(result.output).not.toContain("session terminal")
      }),
    { config: { shell_in_terminal: "visible" } },
  )

  it.instance(
    "falls back when the terminal is busy",
    () =>
      Effect.gen(function* () {
        const capture = yield* PtyCapture.Service
        const ptyID = yield* fakeTerminal()
        yield* capture.begin({
          ptyID,
          sessionID: ctx.sessionID,
          terminalTitle: "Terminal 1",
          command: "vim notes.txt",
          cwd: "/tmp",
        })
        const result = yield* run({ command: "echo busy-fallback" })
        expect(result.output).toContain("busy-fallback")
        expect(result.output).not.toContain("session terminal")
      }),
    { config: { shell_in_terminal: "visible" } },
  )

  it.instance("stays in a subprocess when shell_in_terminal is off", () =>
    Effect.gen(function* () {
      yield* fakeTerminal()
      const result = yield* run({ command: "echo off-mode" })
      expect(result.output).toContain("off-mode")
      expect(result.output).not.toContain("session terminal")
    }),
  )

  it.instance(
    "sends Ctrl+C when the command exceeds its timeout",
    () =>
      Effect.gen(function* () {
        yield* fakeTerminal({ finish: false })
        const result = yield* run({ command: "sleep 99", timeout: 300 })
        expect(result.output).toContain("Ctrl+C")
        expect(result.metadata.exit).toBe(130)
      }),
    { config: { shell_in_terminal: "visible" } },
  )
})
