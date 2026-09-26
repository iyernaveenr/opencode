import { createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useBroadcastQueue } from "@/context/broadcast-queue"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { tabKey, useTabs, type SessionTab } from "@/context/tabs"
import { tabGroupColor } from "@/utils/tab-groups"

export function TabGroupHint() {
  const params = useParams()
  const tabs = useTabs()
  const server = useServer()
  const command = useCommand()
  const language = useLanguage()
  const queue = useBroadcastQueue()

  const group = createMemo(() => {
    const id = params.id
    if (!id) return
    const tab: SessionTab = { type: "session", server: server.key, sessionId: id }
    const found = tabs.groupOf(tab)
    if (!found) return
    const count = tabs.groupMembers(found.id).length
    if (count < 2) return
    return { ...found, count }
  })

  const text = createMemo(() => {
    const value = group()
    if (!value) return ""
    const hint = language.t("tabGroup.hint", {
      name: value.name,
      count: value.count,
      keybind: command.keybindParts("prompt.broadcast").join(" "),
    })
    const held = queue
      .pending()
      .filter((item) => item.group === value.id)
      .map((item) => tabs.info[tabKey(item.tab)]?.title ?? item.title)
    if (held.length === 0) return hint
    return `${hint}. ${language.t("prompt.toast.broadcast.queued", { titles: held.join(", ") })}`
  })

  return (
    <Show when={group()}>
      {(value) => (
        <div
          data-component="tab-group-hint"
          class="flex items-center gap-2 px-3 pb-1.5 text-xs text-text-weak select-none"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: tabGroupColor(value().color) }} />
          <span class="truncate">{text()}</span>
        </div>
      )}
    </Show>
  )
}
