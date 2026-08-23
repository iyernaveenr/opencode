import { createPromptProjectController } from "@/components/prompt-project-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { createEffect, createResource } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { showToast } from "@/utils/toast"
import { normalizeSessionInfo } from "@/utils/session"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useSessionKey } from "@/pages/session/session-layout"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const settings = useSettings()
  const rightMount = useTitlebarRightMount()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const language = useLanguage()
  const local = useLocal()
  const layout = useLayout()
  const tabs = useTabs()
  const navigate = useNavigate()
  const route = useSessionKey()
  const [searchParams] = useSearchParams<{ draftId?: string }>()
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    worktree: workspace.selection.value,
    resetWorktree: workspace.selection.reset,
  })
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  // Opening a terminal shouldn't require burning tokens on a first message: create the
  // session directly (a DB row, no model call), promote the draft like submit does, and
  // open the terminal pane in the promoted session.
  const openTerminalInNewSession = async () => {
    const directory = sdk().directory
    const created = await sdk()
      .api.session.create({ location: { directory } })
      .then(normalizeSessionInfo)
      .catch(() => {
        showToast({ title: language.t("prompt.toast.sessionCreateFailed.title") })
        return undefined
      })
    if (!created) return
    serverSync().session.remember(created)
    const [, setServerStore] = serverSync().child(directory)
    setServerStore("session", (list: Session[]) => {
      const result = Binary.search(list, created.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = created
        return next
      }
      next.splice(result.index, 0, created)
      return next
    })
    local.session.promote(directory, created.id)
    layout.handoff.setTabs(base64Encode(directory), created.id)
    layout.view(route.sessionKey).terminal.open()
    const draftID = searchParams.draftId
    if (draftID) tabs.promoteDraft(draftID, { server: tabs.draft(draftID).server, sessionId: created.id })
    else navigate(`/${base64Encode(directory)}/session/${created.id}`)
  }
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
    terminal: {
      open: () => void openTerminalInNewSession(),
    },
  })
  createEffect(() => {
    if (!draft.prompt.ready()) return
    draft.input.restoreFocus()
  })
  const ready = Promise.resolve()
  const [suspendUntilPromptReady] = createResource(
    () => draft.prompt.readyPromise() ?? ready,
    (promise) => promise.then(() => true),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      {suspendUntilPromptReady()}
      <NewSessionStatus mount={rightMount} visible={settings.visibility.status} />
      <div class="flex-1 min-h-0 flex flex-col gap-2 p-2">
        <NewSessionView input={draft.input} project={project} workspace={workspace} />
      </div>
    </div>
  )
}
