import { createMemo } from "solid-js"
import type { ComposerBroadcastTarget } from "@/composer/adapter"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useServer } from "@/runtime/server/current"
import { tabKey, useTabs, type SessionTab } from "@/shell/tabs/tabs"

/** Session tabs grouped with the current session, on any connected server. */
export function useTabGroupTargets(sessionID: () => string) {
  const tabs = useTabs()
  const server = useServer()
  const servers = useServers()
  const global = useGlobal()

  const current = createMemo((): SessionTab => ({ type: "session", server: server.key, sessionId: sessionID() }))
  const group = createMemo(() => tabs.groupOf(current()))
  const members = createMemo(() => {
    const found = group()
    if (!found) return []
    return tabs.groupMembers(found.id).filter((tab) => tabKey(tab) !== tabKey(current()))
  })

  const targets = (): ComposerBroadcastTarget[] =>
    members().flatMap((tab) => {
      const conn = servers.list.find((item) => ServerConnection.key(item) === tab.server)
      if (!conn) return []
      const ctx = global.ensureServerCtx(conn)
      const data = ctx.data
      const id = tab.sessionId
      return [
        {
          title: tabs.info[tabKey(tab)]?.title ?? data.session.get(id)?.title ?? id,
          load: () => data.session.sync(id),
          busy: () => data.session.status(id) === "running",
          session: () => {
            const info = data.session.get(id)
            if (!info) return
            return {
              id,
              directory: info.location.directory,
              api: ctx.sdk.api.session,
              data,
              current: () => data.session.get(id),
              admitted: (messageID) =>
                data.session.input.has(id, messageID) || !!data.session.message.get(id, messageID),
            }
          },
        },
      ]
    })

  return { group, members, targets }
}
