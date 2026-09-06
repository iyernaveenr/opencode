import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

const ptyTest = process.platform === "win32" ? it.live.skip : it.live

ptyTest("enforces chat-session ownership of PTYs without leaking existence", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const server = yield* startServer(tmp.path)
    const owner = "ses_owner_test"
    const other = "ses_other_test"

    const url = (path: string, sessionID?: string) => {
      const next = new URL(path, server.base)
      next.searchParams.set("location[directory]", tmp.path)
      if (sessionID) next.searchParams.set("sessionID", sessionID)
      return next
    }
    const call = (path: string, init?: RequestInit & { sessionID?: string }) =>
      Effect.promise(() =>
        fetch(url(path, init?.sessionID), {
          ...init,
          headers: { ...server.headers, "content-type": "application/json", ...init?.headers },
        }),
      )

    const created = yield* call("/api/pty", {
      method: "POST",
      body: JSON.stringify({ command: "cat", cwd: tmp.path, sessionID: owner }),
    })
    expect(created.status).toBe(200)
    const owned = (yield* Effect.promise(() => created.json())).data
    expect(owned.sessionID).toBe(owner)
    const id = owned.id as string

    yield* Effect.addFinalizer(() =>
      call(`/api/pty/${id}`, { method: "DELETE", sessionID: owner }).pipe(Effect.ignore),
    )

    // Owner and legacy (no claim) callers see it; a foreign session gets 404, not 403.
    expect((yield* call(`/api/pty/${id}`, { sessionID: owner })).status).toBe(200)
    expect((yield* call(`/api/pty/${id}`)).status).toBe(200)
    expect((yield* call(`/api/pty/${id}`, { sessionID: other })).status).toBe(404)

    // Listing is filtered by claim.
    const json = (response: Response) => Effect.promise(() => response.json())
    const mine = yield* json(yield* call(`/api/pty`, { sessionID: owner }))
    expect(mine.data.map((info: { id: string }) => info.id)).toEqual([id])
    const theirs = yield* json(yield* call(`/api/pty`, { sessionID: other }))
    expect(theirs.data).toEqual([])

    // Mutations and ticket minting from a foreign session are also 404.
    expect(
      (yield* call(`/api/pty/${id}`, { method: "PUT", sessionID: other, body: JSON.stringify({ title: "x" }) })).status,
    ).toBe(404)
    expect((yield* call(`/api/pty/${id}`, { method: "DELETE", sessionID: other })).status).toBe(404)
    expect(
      (yield* call(`/api/pty/${id}/connect-token`, {
        method: "POST",
        sessionID: other,
        headers: { "x-opencode-ticket": "1" },
      })).status,
    ).toBe(404)
    // WebSocket connect from a foreign session is refused before upgrade.
    expect((yield* call(`/api/pty/${id}/connect`, { sessionID: other })).status).toBe(404)

    // The owner can still mint a ticket and the PTY is still alive afterwards.
    expect(
      (yield* call(`/api/pty/${id}/connect-token`, {
        method: "POST",
        sessionID: owner,
        headers: { "x-opencode-ticket": "1" },
      })).status,
    ).toBe(200)
    expect((yield* call(`/api/pty/${id}`, { sessionID: owner })).status).toBe(200)
  }),
)
