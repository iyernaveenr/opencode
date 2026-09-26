import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createBroadcastQueue, type QueuedBroadcast } from "./broadcast-queue"
import type { SessionTab } from "@/context/tabs"

const tab = (sessionId: string): SessionTab => ({
  type: "session",
  server: "server-key" as SessionTab["server"],
  sessionId,
})

// The test harness resolves the non-reactive solid-js server build, so state is plain data
// and flush() is driven by hand; in the app an effect calls it on every tracked change.
function harness() {
  const world = {
    status: {} as Record<string, "idle" | "busy" | "retry" | undefined>,
    group: {} as Record<string, string | undefined>,
    gone: new Set<string>(),
  }
  const outcomes: Array<[string, "sent" | "failed"]> = []
  const sends: string[] = []
  let dispose = () => {}
  const queue = createRoot((done) => {
    dispose = done
    return createBroadcastQueue({
      status: (target) => (world.gone.has(target.sessionId) ? undefined : (world.status[target.sessionId] ?? "idle")),
      groupOf: (target) => world.group[target.sessionId],
      notify: (item, outcome) => {
        outcomes.push([item.title, outcome])
      },
    })
  })
  const item = (
    sessionId: string,
    send?: () => Promise<void>,
    options?: { id?: string; group?: string | null },
  ): QueuedBroadcast => ({
    id: options?.id ?? `q-${sessionId}`,
    tab: tab(sessionId),
    group: options?.group === null ? undefined : (options?.group ?? "g1"),
    title: sessionId,
    draft: {
      sessionID: "origin",
      sessionDirectory: "/repo",
      prompt: [{ type: "text", content: "hello", start: 0, end: 5 }],
      context: [],
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
    text: "hello",
    send:
      send ??
      (async () => {
        sends.push(options?.id ?? sessionId)
      }),
  })
  const step = async () => {
    queue.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { queue, world, outcomes, sends, item, step, dispose }
}

describe("broadcast queue", () => {
  test("delivers a held prompt once the target turns idle", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    h.world.status.s1 = "busy"
    h.queue.enqueue(h.item("s1"))
    await h.step()
    expect(h.sends).toEqual([])
    expect(h.queue.pending()).toHaveLength(1)

    h.world.status.s1 = "retry"
    await h.step()
    expect(h.sends).toEqual([])

    h.world.status.s1 = "idle"
    await h.step()
    expect(h.sends).toEqual(["s1"])
    expect(h.queue.pending()).toEqual([])
    expect(h.outcomes).toEqual([["s1", "sent"]])
    h.dispose()
  })

  test("sends immediately when the target is already idle and reports send failures", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    h.world.group.s2 = "g1"
    h.queue.enqueue(h.item("s1"))
    h.queue.enqueue(
      h.item("s2", async () => {
        throw new Error("offline")
      }),
    )
    await h.step()
    expect(h.sends).toEqual(["s1"])
    expect(h.outcomes.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["s1", "sent"],
      ["s2", "failed"],
    ])
    expect(h.queue.pending()).toEqual([])
    h.dispose()
  })

  test("drops the prompt when the tab leaves its group and fails it when its server is gone", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    h.world.group.s2 = "g1"
    h.world.status.s1 = "busy"
    h.world.status.s2 = "busy"
    h.queue.enqueue(h.item("s1"))
    h.queue.enqueue(h.item("s2"))
    await h.step()
    expect(h.queue.pending()).toHaveLength(2)

    h.world.group.s1 = "other"
    await h.step()
    expect(h.queue.pending().map((item) => item.title)).toEqual(["s2"])
    expect(h.outcomes).toEqual([])

    h.world.gone.add("s2")
    await h.step()
    expect(h.queue.pending()).toEqual([])
    expect(h.outcomes).toEqual([["s2", "failed"]])
    expect(h.sends).toEqual([])
    h.dispose()
  })

  test("remove drops a held prompt and send delivers one now even while its target is busy", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    h.world.group.s2 = "g1"
    h.world.status.s1 = "busy"
    h.world.status.s2 = "busy"
    h.queue.enqueue(h.item("s1"))
    h.queue.enqueue(h.item("s2"))
    await h.step()

    h.queue.remove("q-s1")
    expect(h.queue.pending().map((item) => item.id)).toEqual(["q-s2"])

    h.queue.send("q-s2")
    await h.step()
    expect(h.sends).toEqual(["s2"])
    expect(h.outcomes).toEqual([["s2", "sent"]])
    expect(h.queue.pending()).toEqual([])

    h.queue.send("missing")
    h.queue.remove("missing")
    expect(h.sends).toEqual(["s2"])
    h.dispose()
  })

  test("a plain held prompt needs no group and is kept when the tab is in none", async () => {
    const h = harness()
    h.world.status.s1 = "busy"
    h.queue.enqueue(h.item("s1", undefined, { group: null }))
    await h.step()
    expect(h.queue.pending()).toHaveLength(1)

    h.world.status.s1 = "idle"
    await h.step()
    expect(h.sends).toEqual(["s1"])
    expect(h.outcomes).toEqual([["s1", "sent"]])
    h.dispose()
  })

  test("delivers one prompt per session per idle, oldest first", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    h.world.status.s1 = "busy"
    h.queue.enqueue(h.item("s1", undefined, { id: "first" }))
    h.queue.enqueue(h.item("s1", undefined, { id: "second", group: null }))
    h.queue.enqueue(h.item("s1", undefined, { id: "third" }))
    await h.step()
    expect(h.sends).toEqual([])

    // The turn ends: only the oldest prompt goes out; the send marks the session busy again.
    h.world.status.s1 = "idle"
    await h.step()
    expect(h.sends).toEqual(["first"])
    expect(h.queue.pending().map((item) => item.id)).toEqual(["second", "third"])

    h.world.status.s1 = "busy"
    await h.step()
    expect(h.sends).toEqual(["first"])

    h.world.status.s1 = "idle"
    await h.step()
    expect(h.sends).toEqual(["first", "second"])
    h.world.status.s1 = "busy"
    await h.step()
    h.world.status.s1 = "idle"
    await h.step()
    expect(h.sends).toEqual(["first", "second", "third"])
    expect(h.queue.pending()).toEqual([])
    h.dispose()
  })

  test("a second prompt for the same session waits while the first delivery is in flight", async () => {
    const h = harness()
    h.world.group.s1 = "g1"
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.queue.enqueue(
      h.item(
        "s1",
        async () => {
          h.sends.push("slow")
          await gate
        },
        { id: "slow" },
      ),
    )
    h.queue.enqueue(h.item("s1", undefined, { id: "next" }))
    await h.step()
    expect(h.sends).toEqual(["slow"])
    // Status still reads idle (no optimistic flip in this harness); in-flight tracking alone must hold "next".
    await h.step()
    expect(h.sends).toEqual(["slow"])

    release()
    // In the app the in-flight signal re-runs the effect; here the microtask must settle first.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await h.step()
    expect(h.sends).toEqual(["slow", "next"])
    h.dispose()
  })
})
