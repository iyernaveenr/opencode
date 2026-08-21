import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { TerminalTool } from "../../src/tool/terminal"
import { SessionID, MessageID } from "../../src/session/schema"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Git } from "@/git"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
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
      PtyCapture.node,
      Config.node,
      Truncate.node,
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      Git.node,
    ]),
  ),
)

const run = Effect.fn("TerminalToolTest.run")(function* (params: { action: "list" | "output"; commandID?: string }) {
  const info = yield* TerminalTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const seed = Effect.fn("TerminalToolTest.seed")(function* (sessionID: string, command: string, output: string) {
  const capture = yield* PtyCapture.Service
  const begun = yield* capture.begin({
    ptyID: PtyID.ascending(),
    sessionID,
    terminalTitle: "Terminal 1",
    command,
    cwd: "/tmp",
  })
  yield* capture.append(begun.id, output)
  yield* capture.finish(begun.id, command === "false" ? 1 : 0)
  return begun.id
})

describe("tool.terminal", () => {
  it.instance("reports disabled when terminal_context is off", () =>
    Effect.gen(function* () {
      const result = yield* run({ action: "list" })
      expect(result.output).toContain("disabled")
    }),
  )

  it.instance(
    "lists this session's captured commands with exit codes",
    () =>
      Effect.gen(function* () {
        yield* seed(ctx.sessionID, "lsb_release -a", "Ubuntu 24.04\n")
        yield* seed(ctx.sessionID, "false", "")
        const result = yield* run({ action: "list" })
        expect(result.output).toContain("lsb_release -a")
        expect(result.output).toContain("exit 0")
        expect(result.output).toContain("exit 1")
      }),
    { config: { terminal_context: "tool-only" } },
  )

  it.instance(
    "fetches a command's captured output",
    () =>
      Effect.gen(function* () {
        const id = yield* seed(ctx.sessionID, "lsb_release -a", "Ubuntu 24.04 noble\n")
        const result = yield* run({ action: "output", commandID: id })
        expect(result.output).toContain("Ubuntu 24.04 noble")
        expect(result.output).toContain("exit 0")
      }),
    { config: { terminal_context: "tool-only" } },
  )

  it.instance(
    "denies access to another session's command",
    () =>
      Effect.gen(function* () {
        const foreign = yield* seed("ses_someone_else", "cat ~/.ssh/id_rsa", "SECRET\n")
        const result = yield* run({ action: "output", commandID: foreign })
        expect(result.output).not.toContain("SECRET")
        expect(result.output).toContain("No captured command")
        const list = yield* run({ action: "list" })
        expect(list.output).not.toContain("cat ~/.ssh/id_rsa")
      }),
    { config: { terminal_context: "tool-only" } },
  )

  it.instance(
    "requires commandID for the output action",
    () =>
      Effect.gen(function* () {
        const result = yield* run({ action: "output" })
        expect(result.output).toContain("requires commandID")
      }),
    { config: { terminal_context: "ambient-full" } },
  )
})
