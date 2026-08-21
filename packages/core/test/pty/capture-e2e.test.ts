import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { Pty as PtySchema } from "@opencode-ai/schema/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionID } from "@opencode-ai/schema/session-id"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node, PtyCapture.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const bash = process.platform === "win32" ? undefined : Bun.which("bash")
const bashTest = bash ? it.live : it.live.skip

// End-to-end: a real bash with injected OSC 133/633 integration produces capture
// records for typed commands, attributed to the owning chat session.
describe("PTY command capture via bash integration", () => {
  bashTest("captures command, exit code, and output for the owning session", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const capture = yield* PtyCapture.Service
      const owner = SessionID.descending()
      const info = yield* Effect.acquireRelease(
        pty.create({ command: bash!, cwd: "/tmp", sessionID: owner, env: { TERM: "xterm-256color" } }),
        (created) => pty.remove(created.id).pipe(Effect.ignore),
      )
      expect(info.args[0]).toBe("--rcfile")

      const write = (data: string) => pty.write(info.id, data)
      // Give bash a moment to source rc files before typing.
      yield* Effect.sleep("600 millis")
      yield* write("echo capture-me-$((6*7))\n")
      yield* Effect.sleep("400 millis")
      yield* write("false\n")
      yield* Effect.sleep("400 millis")
      // Aliases expand before $BASH_COMMAND; capture must report the TYPED line.
      yield* write("alias oc_ll='echo aliased-out'\n")
      yield* Effect.sleep("300 millis")
      yield* write("oc_ll\n")

      const deadline = Date.now() + 8000
      let commands: PtySchema.Command[] = []
      while (Date.now() < deadline) {
        commands = yield* capture.list(owner)
        if (commands.filter((command) => command.status === "completed").length >= 4) break
        yield* Effect.sleep("100 millis")
      }

      const completed = commands.filter((command) => command.status === "completed")
      expect(completed.length).toBeGreaterThanOrEqual(4)

      const echo = completed.find((command) => command.command.includes("echo capture-me"))
      expect(echo).toBeDefined()
      expect(echo!.exitCode).toBe(0)
      expect(echo!.cwd).toBe("/tmp")
      const echoOutput = yield* capture.output(owner, echo!.id)
      expect(echoOutput!.head).toContain("capture-me-42")

      const failed = completed.find((command) => command.command.startsWith("false"))
      expect(failed).toBeDefined()
      expect(failed!.exitCode).toBe(1)

      // The typed alias, not its expansion, is the captured command; expansion ran fine.
      const aliased = completed.find((command) => command.command.trim() === "oc_ll")
      expect(aliased).toBeDefined()
      const aliasedOutput = yield* capture.output(owner, aliased!.id)
      expect(aliasedOutput!.head).toContain("aliased-out")

      // Foreign sessions see nothing.
      expect(yield* capture.list(SessionID.descending())).toEqual([])
    }),
  )
})
