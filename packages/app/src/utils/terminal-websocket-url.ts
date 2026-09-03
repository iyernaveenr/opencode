import { authTokenFromCredentials } from "@/utils/server"

// Where server replay starts. A stored cursor is only meaningful together with the
// screen snapshot it complements: with both, resume from the cursor; snapshot
// alone tails (-1); otherwise replay the full retained buffer (0) so scrollback
// survives snapshot loss (e.g. session store swaps on tab switch).
export function initialReplayCursor(stored: number | undefined, hasSnapshot: boolean): number {
  if (hasSnapshot) return stored ?? -1
  return 0
}

export function terminalWebSocketURL(input: {
  protocol?: "v1" | "v2"
  url: string
  id: string
  directory: string
  cursor: number
  ticket?: string
  sameOrigin?: boolean
  username?: string
  password?: string
  authToken?: boolean
  sessionID?: string
}) {
  const isV1 = input.protocol === "v1"
  const next = new URL(`${input.url}${isV1 ? `/pty/${input.id}/connect` : `/api/pty/${input.id}/connect`}`)
  if (isV1) {
    next.searchParams.set("directory", input.directory)
  } else {
    next.searchParams.set("location[directory]", input.directory)
  }
  next.searchParams.set("cursor", String(input.cursor))
  if (input.sessionID) next.searchParams.set("sessionID", input.sessionID)
  next.protocol = next.protocol === "https:" ? "wss:" : "ws:"
  if (input.ticket) {
    next.searchParams.set("ticket", input.ticket)
    return next
  }
  if (isV1 && input.password && (!input.sameOrigin || input.authToken)) {
    next.searchParams.set(
      "auth_token",
      authTokenFromCredentials({ username: input.username, password: input.password }),
    )
  }
  return next
}
