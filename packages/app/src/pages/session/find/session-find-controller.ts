import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { makeEventListener } from "@solid-primitives/event-listener"
import { batch, createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { activeRange, applyFindHighlights, clearFindHighlights, scrollRangeIntoView } from "./find-highlight"
import { findMatches, findPattern, startIndex, stepIndex, type FindMatch } from "./find-matches"

export type SessionFindController = ReturnType<typeof createSessionFindController>

const matchKey = (match: FindMatch) => `${match.messageID}\n${match.partID}\n${match.ordinal}`
const SELECTION_PREFILL_MAX = 200
const LOAD_OLDER_MAX_PAGES = 500

export function createSessionFindController(input: {
  sessionID: Accessor<string | undefined>
  userMessages: Accessor<UserMessage[]>
  messages: Accessor<Message[]>
  parts: (messageID: string) => Part[]
  reasoning: Accessor<boolean>
  scroller: () => HTMLElement | undefined
  revealMessage: (userMessageID: string, partID?: string) => void
  cursor: () => string | undefined
  history: { more: Accessor<boolean>; loading: Accessor<boolean>; loadOlder: () => Promise<void> }
  pauseAutoScroll: () => void
  onClose?: () => void
}) {
  const command = useCommand()
  const language = useLanguage()
  const [state, setState] = createStore({ open: false, query: "", index: -1, loading: false })
  let inputEl: HTMLInputElement | undefined
  let activeKey: string | undefined
  let frame: number | undefined
  let loadToken = 0

  const assistantsByParent = createMemo(() => {
    const result = new Map<string, AssistantMessage[]>()
    for (const message of input.messages()) {
      if (message.role !== "assistant") continue
      const list = result.get(message.parentID)
      if (list) list.push(message)
      else result.set(message.parentID, [message])
    }
    return result
  })
  const pattern = createMemo(() => (state.open ? findPattern(state.query) : undefined))
  const matches = createMemo(() => {
    if (!state.open || !pattern()) return []
    return findMatches({
      userMessages: input.userMessages(),
      assistants: (id) => assistantsByParent().get(id) ?? [],
      parts: input.parts,
      query: state.query,
      reasoning: input.reasoning(),
    })
  })
  const active = createMemo(() => matches()[state.index])
  const activeID = createMemo(() => {
    const match = active()
    return match ? matchKey(match) : undefined
  })

  const locate = (match: FindMatch) => {
    const root = input.scroller()
    if (!root) return undefined
    if (match.role === "user")
      return root.querySelector<HTMLElement>(
        `[data-timeline-row="UserMessage"][data-message-id="${CSS.escape(match.userMessageID)}"]`,
      )
    return root.querySelector<HTMLElement>(`[data-part-id="${CSS.escape(match.partID)}"]`)
  }

  const refresh = () => {
    const root = input.scroller()
    if (!root) return
    const current = active()
    const re = pattern()
    const element = current && re ? locate(current) : undefined
    applyFindHighlights({
      scope: root,
      pattern: re,
      active: element && re && current ? activeRange(element, re, current.ordinal) : undefined,
    })
  }

  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      refresh()
    })
  }

  // The timeline is virtualized, so the row may need a frame or two to render after reveal.
  const seek = (match: FindMatch, left: number) => {
    const root = input.scroller()
    const re = pattern()
    if (!root || !re || activeID() !== matchKey(match)) return
    const element = locate(match)
    if (element) {
      const range = activeRange(element, re, match.ordinal)
      if (range) scrollRangeIntoView(root, range)
      else element.scrollIntoView({ block: "center" })
      refresh()
      return
    }
    if (left <= 0) {
      refresh()
      return
    }
    requestAnimationFrame(() => seek(match, left - 1))
  }

  const go = (match: FindMatch | undefined) => {
    if (!match) {
      refresh()
      return
    }
    input.pauseAutoScroll()
    input.revealMessage(match.userMessageID, match.role === "assistant" ? match.partID : undefined)
    seek(match, 8)
  }

  // A new query starts from the turn in view; the same query keeps its match while history grows.
  createEffect(
    on(
      () => [state.open, state.query] as const,
      () => {
        const list = matches()
        const index = startIndex(list, input.userMessages(), input.cursor())
        setState("index", index)
        activeKey = list[index] ? matchKey(list[index]) : undefined
      },
    ),
  )
  createEffect(
    on(matches, (list) => {
      if (!state.open) return
      const key = activeKey
      const found = key ? list.findIndex((match) => matchKey(match) === key) : -1
      const index = found !== -1 ? found : list.length === 0 ? -1 : Math.min(Math.max(state.index, 0), list.length - 1)
      if (index !== state.index) setState("index", index)
      activeKey = list[index] ? matchKey(list[index]) : undefined
      schedule()
    }),
  )
  createEffect(on(activeID, () => go(active())))
  createEffect(() => {
    if (!state.open) clearFindHighlights()
  })
  createEffect(on(input.sessionID, () => close(), { defer: true }))

  createEffect(() => {
    const root = input.scroller()
    if (!root || !state.open) return
    onCleanup(makeEventListener(root, "scroll", schedule, { passive: true }))
  })

  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    clearFindHighlights()
  })

  function open() {
    const selected = window.getSelection()?.toString().trim() ?? ""
    const prefill = selected && selected.length <= SELECTION_PREFILL_MAX && !selected.includes("\n") ? selected : ""
    batch(() => {
      if (prefill) setState("query", prefill)
      setState("open", true)
    })
    requestAnimationFrame(() => {
      inputEl?.focus()
      inputEl?.select()
    })
  }

  function close() {
    if (!state.open) return
    loadToken += 1
    batch(() => {
      setState("open", false)
      setState("loading", false)
    })
    input.onClose?.()
  }

  function move(delta: 1 | -1) {
    const list = matches()
    const index = stepIndex(state.index, list.length, delta)
    if (index === state.index) {
      go(list[index])
      return
    }
    setState("index", index)
    activeKey = list[index] ? matchKey(list[index]) : undefined
  }

  async function loadOlder() {
    if (state.loading || !input.history.more()) return
    const token = ++loadToken
    setState("loading", true)
    try {
      for (let page = 0; page < LOAD_OLDER_MAX_PAGES; page += 1) {
        if (token !== loadToken || !input.history.more()) break
        if (input.history.loading()) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          continue
        }
        await input.history.loadOlder()
      }
    } finally {
      if (token === loadToken) setState("loading", false)
    }
  }

  command.register("session.find", () => [
    {
      id: "session.find",
      title: language.t("command.session.find"),
      keybind: "mod+f",
      disabled: !input.sessionID(),
      onSelect: open,
    },
  ])

  return {
    open: () => state.open,
    query: () => state.query,
    index: () => state.index,
    matches,
    active,
    loading: () => state.loading,
    setQuery: (value: string) => setState("query", value),
    setInput: (el: HTMLInputElement | undefined) => {
      inputEl = el
    },
    show: open,
    close,
    next: () => move(1),
    previous: () => move(-1),
    loadOlder,
  }
}
