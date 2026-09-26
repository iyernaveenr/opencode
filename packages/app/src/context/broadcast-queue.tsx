import { createContext, useContext, type ParentProps } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { createBroadcastQueue, type BroadcastQueue } from "@/utils/broadcast-queue"
import { showToast } from "@/utils/toast"

const Context = createContext<BroadcastQueue>()

export function BroadcastQueueProvider(props: ParentProps) {
  const global = useGlobal()
  const tabs = useTabs()
  const language = useLanguage()

  const value = createBroadcastQueue({
    status: (tab) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      if (!conn) return undefined
      return global.ensureServerCtx(conn).sync.session.data.session_status[tab.sessionId]?.type ?? "idle"
    },
    groupOf: (tab) => tabs.groupOf(tab)?.id,
    notify: (item, outcome) =>
      showToast({
        variant: outcome === "failed" ? "error" : undefined,
        title: language.t("prompt.toast.broadcast.title"),
        description: language.t(`prompt.toast.broadcast.${outcome}`, { titles: item.title }),
      }),
  })

  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useBroadcastQueue() {
  const value = useContext(Context)
  if (!value) throw new Error("useBroadcastQueue must be used within a BroadcastQueueProvider")
  return value
}
