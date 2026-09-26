import { createEffect, createSignal, untrack } from "solid-js"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { SessionTab } from "@/context/tabs"

// A group send held back because its target was still answering; delivered once that turn ends.
export type QueuedBroadcast = {
  id: string
  tab: SessionTab
  // Group the tab belonged to when the prompt was held back; leaving it drops the prompt.
  group: string
  title: string
  // What was held back: shown in the target's dock and restorable into its composer.
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
  const remove = (item: QueuedBroadcast) => setPending((list) => list.filter((entry) => entry !== item))

  const deliver = (item: QueuedBroadcast) => {
    remove(item)
    item.send().then(
      () => deps.notify(item, "sent"),
      () => deps.notify(item, "failed"),
    )
  }

  const flush = () => {
    for (const item of pending()) {
      if (deps.groupOf(item.tab) !== item.group) {
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
      if (current !== "idle") continue
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
