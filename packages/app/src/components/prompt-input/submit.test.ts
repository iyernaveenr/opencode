import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  location?: { directory: string }
}> = []
const enabledAutoAccept: Array<{ server: string; sessionID: string; directory: string }> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0

type GroupTab = { type: "session"; server: string; sessionId: string }
let groupTabs: GroupTab[] = []
const groupSessions: Record<
  string,
  {
    id: string
    directory: string
    title: string
    agent?: string
    model?: { id: string; providerID: string; variant?: string }
  }
> = {}
const busySessions = new Set<string>()
const broadcastPrompts: Array<{ directory: string; input: any }> = []
const broadcastOptimistic: Array<{ directory: string; sessionID?: string; message: any }> = []
const queuedBroadcasts: Array<{
  id: string
  tab: GroupTab
  group: string
  title: string
  text: string
  draft: { prompt: unknown }
  send: () => Promise<void>
}> = []

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionServer = "server-a"
let createSessionGate: Promise<void> | undefined

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  reset: () => undefined,
  set: () => undefined,
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => prompt,
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: () => 0,
    toaster: { dismiss: () => undefined },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/permission", () => {
    const state = (server: string) => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ server, sessionID, directory })
      },
    })
    return { usePermission: () => ({ currentServerState: () => state(permissionServer) }) }
  })

  // Module mocks leak across test files; keep the real exports other suites rely on.
  const realServer = await import("@/context/server")
  mock.module("@/context/server", () => ({
    ...realServer,
    useServer: () => ({ key: "server-key" }),
    ServerConnection: {
      ...realServer.ServerConnection,
      key: (conn: { url: string }) => conn.url.replace("http://", ""),
    },
  }))

  mock.module("@/context/tabs", () => ({
    tabKey: (tab: GroupTab) => `${tab.server}\n${tab.sessionId}`,
    useTabs: () => ({
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
      info: {},
      groupOf: (tab: GroupTab) =>
        groupTabs.some((item) => item.sessionId === tab.sessionId && item.server === tab.server)
          ? {
              id: "group",
              name: "Models",
              color: 0,
              tabs: groupTabs.map((item) => `${item.server}\n${item.sessionId}`),
            }
          : undefined,
      groupMembers: () => groupTabs,
    }),
  }))

  mock.module("@/context/global", () => ({
    useGlobal: () => ({
      servers: { list: () => [{ url: "http://server-key" }] },
      ensureServerCtx: () => ({
        sync: {
          session: {
            peek: (id: string) => groupSessions[id],
            resolve: async (id: string) => groupSessions[id],
            data: {
              get session_status() {
                return Object.fromEntries([...busySessions].map((id) => [id, { type: "busy" }]))
              },
            },
            set: () => undefined,
          },
          ensureDirSyncContext: (directory: string) => ({
            session: {
              optimistic: {
                add: (value: { sessionID?: string; message: unknown }) =>
                  broadcastOptimistic.push({ directory, sessionID: value.sessionID, message: value.message }),
                remove: () => undefined,
              },
            },
            data: { command: [] },
            set: () => undefined,
          }),
        },
        sdk: {
          ensureDirSdkContext: (directory: string) => ({
            api: {
              session: {
                prompt: async (input: unknown) => {
                  broadcastPrompts.push({ directory, input })
                },
                command: async () => undefined,
              },
            },
          }),
        },
      }),
    }),
  }))

  mock.module("@/context/broadcast-queue", () => ({
    useBroadcastQueue: () => ({
      enqueue: (item: (typeof queuedBroadcasts)[number]) => {
        queuedBroadcasts.push(item)
      },
      pending: () => queuedBroadcasts,
      flush: () => undefined,
      remove: () => undefined,
      send: () => undefined,
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      session: {
        remember: () => undefined,
        set: () => undefined,
        sync: async () => {
          serverSessionSyncs++
        },
        data: {
          get session_status() {
            return Object.fromEntries([...busySessions].map((id) => [id, { type: "busy" }]))
          },
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
      plural: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  sessionCreateInputs.length = 0
  enabledAutoAccept.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionServer = "server-a"
  createSessionGate = undefined
  serverSessionSyncs = 0
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
  groupTabs = []
  for (const key of Object.keys(groupSessions)) delete groupSessions[key]
  busySessions.clear()
  broadcastPrompts.length = 0
  broadcastOptimistic.length = 0
  queuedBroadcasts.length = 0
})

describe("prompt submit worktree selection", () => {
  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies auto-accept to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("keeps auto-accept bound to the submission server", async () => {
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => true,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionServer = "server-b"
    release()
    await result

    expect(enabledAutoAccept).toEqual([{ server: "server-a", sessionID: "session-1", directory: "/repo/worktree-a" }])
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})

describe("prompt submit tab group broadcast", () => {
  const create = () =>
    createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      autoAccept: () => false,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  test("lists the other session tabs of the current group as targets", () => {
    params = { id: "session-1" }
    groupTabs = [
      { type: "session", server: "server-key", sessionId: "session-1" },
      { type: "session", server: "server-key", sessionId: "session-2" },
      { type: "session", server: "server-key", sessionId: "session-3" },
    ]
    expect(
      create()
        .broadcastTargets()
        .map((tab) => tab.sessionId),
    ).toEqual(["session-2", "session-3"])
    groupTabs = []
    expect(create().broadcastTargets()).toEqual([])
  })

  test("sends the same prompt to every other tab with that session's own model and directory", async () => {
    params = { id: "session-1" }
    variant = "high"
    groupTabs = [
      { type: "session", server: "server-key", sessionId: "session-1" },
      { type: "session", server: "server-key", sessionId: "session-2" },
      { type: "session", server: "server-key", sessionId: "session-3" },
      { type: "session", server: "server-key", sessionId: "session-4" },
    ]
    groupSessions["session-2"] = {
      id: "session-2",
      directory: "/repo/other",
      title: "Kimi",
      agent: "plan",
      model: { id: "kimi-k3", providerID: "moonshotai" },
    }
    groupSessions["session-3"] = { id: "session-3", directory: "/repo/main", title: "Fresh" }
    groupSessions["session-4"] = { id: "session-4", directory: "/repo/main", title: "Busy" }
    busySessions.add("session-4")

    await create().handleSubmit({ preventDefault: () => undefined } as unknown as Event, { broadcast: true })
    await flush()

    expect(sentPrompts).toEqual(["/repo/main"])
    expect(broadcastPrompts.map((item) => item.directory).sort()).toEqual(["/repo/main", "/repo/other"])
    const kimi = broadcastPrompts.find((item) => item.directory === "/repo/other")!.input
    expect(kimi).toMatchObject({
      sessionID: "session-2",
      agent: "plan",
      model: { providerID: "moonshotai", modelID: "kimi-k3" },
      variant: undefined,
      text: "ls",
    })
    const fresh = broadcastPrompts.find((item) => item.directory === "/repo/main")!.input
    expect(fresh).toMatchObject({
      sessionID: "session-3",
      agent: "agent",
      model: { providerID: "provider", modelID: "model" },
      variant: "high",
    })
    expect(broadcastOptimistic.map((item) => item.sessionID).sort()).toEqual(["session-2", "session-3"])
    expect(broadcastPrompts.some((item) => item.input.sessionID === "session-4")).toBe(false)
    // The busy target is held back, not skipped; its send runs later with that session's own model.
    expect(queuedBroadcasts.map((item) => [item.title, item.group, item.tab.sessionId, item.text])).toEqual([
      ["Busy", "group", "session-4", "ls"],
    ])
    expect(queuedBroadcasts[0].id).toBeTruthy()
    expect(queuedBroadcasts[0].draft.prompt).toEqual(promptValue)
    groupSessions["session-4"] = {
      ...groupSessions["session-4"],
      agent: "plan",
      model: { id: "slow-model", providerID: "ollama" },
    }
    await queuedBroadcasts[0].send()
    const late = broadcastPrompts.find((item) => item.input.sessionID === "session-4")!.input
    expect(late).toMatchObject({
      sessionID: "session-4",
      agent: "plan",
      model: { providerID: "ollama", modelID: "slow-model" },
      text: "ls",
    })
  })

  test("holds the originating tab in the queue when it is busy instead of steering its turn", async () => {
    params = { id: "session-1" }
    groupTabs = [
      { type: "session", server: "server-key", sessionId: "session-1" },
      { type: "session", server: "server-key", sessionId: "session-2" },
    ]
    groupSessions["session-1"] = { id: "session-1", directory: "/repo/main", title: "Me" }
    groupSessions["session-2"] = { id: "session-2", directory: "/repo/main", title: "Other" }
    busySessions.add("session-1")

    await create().handleSubmit({ preventDefault: () => undefined } as unknown as Event, { broadcast: true })
    await flush()

    // Nothing went through the plain submit path, which would have steered the running turn.
    expect(sentPrompts).toEqual([])
    expect(broadcastPrompts.map((item) => item.input.sessionID)).toEqual(["session-2"])
    expect(queuedBroadcasts.map((item) => [item.title, item.tab.sessionId])).toEqual([["Me", "session-1"]])

    busySessions.clear()
    await queuedBroadcasts[0].send()
    expect(broadcastPrompts.map((item) => item.input.sessionID).sort()).toEqual(["session-1", "session-2"])
    const mine = broadcastPrompts.find((item) => item.input.sessionID === "session-1")!.input
    expect(mine).toMatchObject({ agent: "agent", model: { providerID: "provider", modelID: "model" }, text: "ls" })
  })

  test("does not fan out without the broadcast option", async () => {
    params = { id: "session-1" }
    groupTabs = [
      { type: "session", server: "server-key", sessionId: "session-1" },
      { type: "session", server: "server-key", sessionId: "session-2" },
    ]
    groupSessions["session-2"] = { id: "session-2", directory: "/repo/main", title: "Other" }

    await create().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await flush()

    expect(sentPrompts).toEqual(["/repo/main"])
    expect(broadcastPrompts).toEqual([])
  })
})
