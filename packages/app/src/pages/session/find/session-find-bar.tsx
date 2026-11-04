import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import type { SessionFindController } from "./session-find-controller"

export function SessionFindBar(props: { controller: SessionFindController; more: boolean }) {
  const language = useLanguage()
  const find = props.controller
  const total = createMemo(() => find.matches().length)
  const count = createMemo(() => {
    if (!find.query().trim()) return ""
    if (total() === 0) return language.t("session.find.none")
    return language.t("session.find.count", { current: String(find.index() + 1), total: String(total()) })
  })

  return (
    <Show when={find.open()}>
      <div
        data-component="session-find-bar"
        role="search"
        class="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-md border border-border-weak-base bg-background-stronger pl-2 pr-1 py-1 shadow-md"
      >
        <input
          ref={find.setInput}
          type="text"
          class="w-56 min-w-0 border-0 bg-transparent outline-0 text-13-regular text-text-strong placeholder:text-text-weak"
          value={find.query()}
          placeholder={language.t("session.find.placeholder")}
          aria-label={language.t("session.find.placeholder")}
          autocomplete="off"
          spellcheck={false}
          onInput={(event) => find.setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              if (event.shiftKey) find.previous()
              else find.next()
              return
            }
            if (event.key === "Escape") {
              event.preventDefault()
              find.close()
            }
          }}
        />
        <span class="shrink-0 min-w-14 text-right text-12-regular text-text-weak tabular-nums" aria-live="polite">
          {count()}
        </span>
        <IconButton
          icon="chevron-down"
          variant="ghost"
          size="small"
          class="rotate-180"
          disabled={total() === 0}
          aria-label={language.t("session.find.previous")}
          title={language.t("session.find.previous")}
          onClick={() => find.previous()}
        />
        <IconButton
          icon="chevron-down"
          variant="ghost"
          size="small"
          disabled={total() === 0}
          aria-label={language.t("session.find.next")}
          title={language.t("session.find.next")}
          onClick={() => find.next()}
        />
        <Show when={props.more}>
          <Button size="small" variant="ghost" disabled={find.loading()} onClick={() => void find.loadOlder()}>
            {find.loading() ? language.t("common.loading") : language.t("session.find.loadOlder")}
          </Button>
        </Show>
        <IconButton
          icon="close-small"
          variant="ghost"
          size="small"
          aria-label={language.t("common.close")}
          title={language.t("common.close")}
          onClick={() => find.close()}
        />
      </div>
    </Show>
  )
}
