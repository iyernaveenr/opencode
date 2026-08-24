import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config as CoreConfig } from "@opencode-ai/core/config"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { Pty } from "@opencode-ai/core/pty"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ShellTool } from "../../src/tool/shell"
import { SessionID, MessageID } from "../../src/session/schema"
import { Config } from "@/config/config"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
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

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make("/tmp"),
    workspaceID: undefined,
    project: { id: Project.ID.global, directory: AbsolutePath.make("/tmp") },
    vcs: undefined,
  }),
)
const coreConfigLayer = Layer.mock(CoreConfig.Service)({ entries: () => Effect.succeed([]) })

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
      PtyCapture.node,
      Pty.node,
      EventV2.node,
    ]),
    [
      [CoreConfig.node, coreConfigLayer],
      [Location.node, locationLayer],
    ],
  ),
)

const bash = process.platform === "win32" ? undefined : Bun.which("bash")
const bashIt = bash ? it.instance : it.instance.skip

// Full-chain e2e: a real session-owned bash PTY registers a terminal handle, the
// shell tool types into it, and real OSC 133 markers carry the result back.
describe("tool.shell terminal mode e2e", () => {
  bashIt(
    "executes in a real session PTY and harvests real output",
    () =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const capture = yield* PtyCapture.Service
        const created = yield* Effect.acquireRelease(
          pty.create({ command: bash!, cwd: "/tmp", sessionID: ctx.sessionID, env: { TERM: "xterm-256color" } }),
          (info) => pty.remove(info.id).pipe(Effect.ignore),
        )
        expect(created.args[0]).toBe("--rcfile")
        // Let bash source rc files and reach its first prompt.
        yield* Effect.sleep("600 millis")

        const info = yield* ShellTool
        const tool = yield* info.init()
        const result = yield* tool.execute({ command: "echo e2e-visible-$((6*7))" }, ctx)

        expect(result.output).toContain("e2e-visible-42")
        expect(result.output).toContain("session terminal")
        expect(result.metadata.exit).toBe(0)

        const commands = yield* capture.list(ctx.sessionID)
        const record = commands.find((command) => command.command === "echo e2e-visible-$((6*7))")
        expect(record?.ptyID).toBe(created.id)
        expect(record?.status).toBe("completed")
      }),
    { config: { shell_in_terminal: "visible" } },
    15000,
  )
})
