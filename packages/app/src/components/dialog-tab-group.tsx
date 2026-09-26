import { Component, createMemo, createSignal, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useTabs, type SessionTab } from "@/context/tabs"
import { tabGroupColor } from "@/utils/tab-groups"

type Item = { id: string; name: string; count: number; color: number | undefined; kind: "group" | "remove" }

export const DialogTabGroup: Component<{ tab: SessionTab }> = (props) => {
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const current = createMemo(() => tabs.groupOf(props.tab))

  const items = createMemo((): Item[] => {
    const groups = Object.values(tabs.groups).map((group) => ({
      id: group.id,
      name: group.name,
      count: group.tabs.length,
      color: group.color,
      kind: "group" as const,
    }))
    if (!current()) return groups
    return [
      ...groups,
      { id: "remove", name: language.t("dialog.tabGroup.remove"), count: 0, color: undefined, kind: "remove" as const },
    ]
  })

  const pending = createMemo(() => {
    const name = query().trim()
    if (!name) return
    const exists = items().some((item) => item.kind === "group" && item.name.toLowerCase() === name.toLowerCase())
    return exists ? undefined : name
  })

  const assign = (groupID: string | undefined) => {
    tabs.assignGroup(props.tab, groupID)
    dialog.close()
  }

  const create = () => {
    const name = pending()
    if (!name) return
    if (tabs.createGroup(name, props.tab)) dialog.close()
  }

  const select = (item: Item | undefined) => {
    if (!item) return
    assign(item.kind === "remove" ? undefined : item.id)
  }

  return (
    <Dialog title={language.t("dialog.tabGroup.title")}>
      <List
        class="flex-1 px-3 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0"
        search={{ placeholder: language.t("dialog.tabGroup.search.placeholder"), autofocus: true }}
        emptyMessage={pending() ? language.t("dialog.tabGroup.create", { name: pending()! }) : undefined}
        key={(x) => x.id}
        items={items}
        filterKeys={["name"]}
        current={items().find((item) => item.id === current()?.id)}
        onFilter={setQuery}
        onKeyEvent={(event, item) => {
          if (event.key !== "Enter" || item || !pending()) return
          event.preventDefault()
          create()
        }}
        onSelect={select}
        add={{
          render: () => (
            <Show when={pending()}>
              {(name) => (
                <Button variant="ghost" class="w-full justify-start" onClick={create}>
                  {language.t("dialog.tabGroup.create", { name: name() })}
                </Button>
              )}
            </Show>
          ),
        }}
      >
        {(item) => (
          <div class="w-full flex items-center gap-2">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              style={{ background: item.color === undefined ? "transparent" : tabGroupColor(item.color) }}
            />
            <span class="truncate flex-1 min-w-0 text-left font-normal">{item.name}</span>
            <Show when={item.kind === "group"}>
              <span class="text-text-weak shrink-0 font-normal">
                {language.t("dialog.tabGroup.members", { count: item.count })}
              </span>
            </Show>
          </div>
        )}
      </List>
    </Dialog>
  )
}
