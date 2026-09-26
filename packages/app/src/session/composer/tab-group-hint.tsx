import { createMemo, Show } from "solid-js"
import { useParams } from "@solidjs/router"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useTabs, type SessionTab } from "@/shell/tabs/tabs"
import { tabGroupColor } from "@/shell/tabs/groups"

export function TabGroupHint() {
  const params = useParams()
  const tabs = useTabs()
  const server = useServer()
  const command = useCommand()
  const language = useLanguage()

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

  return (
    <Show when={group()}>
      {(value) => (
        <div
          data-component="tab-group-hint"
          class="flex items-center gap-2 px-3 pb-1.5 text-xs text-text-weak select-none"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: tabGroupColor(value().color) }} />
          <span class="truncate">
            {language.t("tabGroup.hint", {
              name: value().name,
              count: value().count,
              keybind: command.keybindParts("prompt.broadcast").join(" "),
            })}
          </span>
        </div>
      )}
    </Show>
  )
}
