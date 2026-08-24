import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(PtyCapture.node))

describe("PTY command capture store", () => {
  it.live("records lifecycle and lists per session", () =>
    Effect.gen(function* () {
      const capture = yield* PtyCapture.Service
      const begun = yield* capture.begin({
        ptyID: PtyID.ascending(),
        sessionID: "ses_capture_a",
        terminalTitle: "Terminal 1",
        command: "false",
        cwd: "/tmp",
      })
      expect(begun.status).toBe("running")
      yield* capture.append(begun.id, "some output\n")
      const finished = yield* capture.finish(begun.id, 1)
      expect(finished?.exitCode).toBe(1)
      expect(finished?.status).toBe("completed")

      const list = yield* capture.list("ses_capture_a")
      expect(list.map((command) => command.id)).toEqual([begun.id])
      expect(yield* capture.list("ses_capture_other")).toEqual([])

      const record = yield* capture.output("ses_capture_a", begun.id)
      expect(record?.head).toBe("some output\n")
      // Cross-session output access is denied.
      expect(yield* capture.output("ses_capture_other", begun.id)).toBeUndefined()
    }),
  )

  it.live("bounds output with head+tail and marks truncation", () =>
    Effect.gen(function* () {
      const capture = yield* PtyCapture.Service
      const begun = yield* capture.begin({
        ptyID: PtyID.ascending(),
        sessionID: "ses_capture_big",
        terminalTitle: "Terminal 1",
        command: "yes",
      })
      const chunk = "x".repeat(16 * 1024)
      for (let index = 0; index < 8; index++) yield* capture.append(begun.id, chunk)
      const record = yield* capture.output("ses_capture_big", begun.id)
      expect(record?.info.truncated).toBe(true)
      expect(record?.info.outputBytes).toBe(8 * 16 * 1024)
      expect(record!.head.length + record!.tail.length).toBeLessThanOrEqual(64 * 1024)
    }),
  )

  it.live("evicts oldest commands beyond the per-session ring", () =>
    Effect.gen(function* () {
      const capture = yield* PtyCapture.Service
      const ptyID = PtyID.ascending()
      const ids: string[] = []
      for (let index = 0; index < 55; index++) {
        const begun = yield* capture.begin({
          ptyID,
          sessionID: "ses_capture_ring",
          terminalTitle: "Terminal 1",
          command: `echo ${index}`,
        })
        ids.push(begun.id)
        yield* capture.finish(begun.id, 0)
      }
      const list = yield* capture.list("ses_capture_ring")
      expect(list.length).toBe(50)
      expect(list[0]?.id).toBe(ids[5]!)
      expect(yield* capture.output("ses_capture_ring", ids[0]!)).toBeUndefined()
    }),
  )

  it.live("tracks terminal handles per session, last registered wins", () =>
    Effect.gen(function* () {
      const capture = yield* PtyCapture.Service
      const first = PtyID.ascending()
      const second = PtyID.ascending()
      const noop = () => {}
      expect(yield* capture.terminal("ses_capture_term")).toBeUndefined()
      yield* capture.registerTerminal("ses_capture_term", { ptyID: first, write: noop })
      yield* capture.registerTerminal("ses_capture_term", { ptyID: second, write: noop })
      expect((yield* capture.terminal("ses_capture_term"))?.ptyID).toBe(second)
      expect(yield* capture.terminal("ses_capture_other")).toBeUndefined()
      yield* capture.unregisterTerminal("ses_capture_term", second)
      expect((yield* capture.terminal("ses_capture_term"))?.ptyID).toBe(first)
      yield* capture.unregisterTerminal("ses_capture_term", first)
      expect(yield* capture.terminal("ses_capture_term")).toBeUndefined()
    }),
  )
})
