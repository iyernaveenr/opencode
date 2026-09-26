import { createEffect, createSignal, untrack } from "solid-js"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { SessionTab } from "@/context/tabs"

// Only used to serialise deliveries per session; not a tab key.
const sessionKey = (tab: SessionTab) => `${tab.server}\n${tab.sessionId}`

// A prompt held back because its session was still answering; delivered once that turn ends.
export type QueuedBroadcast = {
  id: string
  tab: SessionTab
  // Set for group sends: the group the tab belonged to when the prompt was held back; leaving
  // it drops the prompt. Undefined for a plain send held in its own session.
  group?: string
  title: string
  // What was held back: shown in the session's dock and restorable into its composer.
  draft: FollowupDraft
  text: string
  send: () => Promise<void>
}

export type BroadcastQueueDeps = {
  // Reactive reads: the queue re-evaluates whenever these change.
  status: (tab: SessionTab) => "idle" | "busy" | "retry" | undefined
  groupOf: (tab: SessionTab) => string | undefined
  notify: (item: QueuedBroadcast, outcome: "sent" | "failed") => void
}

export type BroadcastQueue = {
  enqueue: (item: QueuedBroadcast) => void
  pending: () => QueuedBroadcast[]
  // Re-evaluates every held prompt; an effect over the reactive reads calls it in the app.
  flush: () => void
  remove: (id: string) => void
  // Delivers a held prompt now, even if its target is still answering.
  send: (id: string) => void
}

export function createBroadcastQueue(deps: BroadcastQueueDeps): BroadcastQueue {
  const [pending, setPending] = createSignal<QueuedBroadcast[]>([])
  // Sessions with a delivery in progress; the next held prompt waits for the next idle.
  const [inflight, setInflight] = createSignal<ReadonlySet<string>>(new Set())
  const remove = (item: QueuedBroadcast) => setPending((list) => list.filter((entry) => entry !== item))

  const deliver = (item: QueuedBroadcast) => {
    const key = sessionKey(item.tab)
    remove(item)
    setInflight((set) => new Set([...set, key]))
    const settle = () =>
      setInflight((set) => {
        const next = new Set(set)
        next.delete(key)
        return next
      })
    item.send().then(
      () => {
        settle()
        deps.notify(item, "sent")
      },
      () => {
        settle()
        deps.notify(item, "failed")
      },
    )
  }

  const flush = () => {
    const taken = new Set(inflight())
    for (const item of pending()) {
      if (item.group !== undefined && deps.groupOf(item.tab) !== item.group) {
        untrack(() => remove(item))
        continue
      }
      const current = deps.status(item.tab)
      if (current === undefined) {
        untrack(() => {
          remove(item)
          deps.notify(item, "failed")
        })
        continue
      }
      const key = sessionKey(item.tab)
      if (current !== "idle" || taken.has(key)) continue
      taken.add(key)
      untrack(() => deliver(item))
    }
  }

  createEffect(flush)

  const find = (id: string) => untrack(pending).find((item) => item.id === id)

  return {
    enqueue: (item) => setPending((list) => [...list, item]),
    pending,
    flush,
    remove: (id) => {
      const item = find(id)
      if (item) remove(item)
    },
    send: (id) => {
      const item = find(id)
      if (item) deliver(item)
    },
  }
}
