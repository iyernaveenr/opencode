export * as PtyCapture from "./capture"

import { Context, Effect, Layer } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { ascending } from "@opencode-ai/schema/identifier"
import { makeGlobalNode } from "../effect/app-node"

// In-memory, bounded capture of shell commands observed via OSC 133 markers.
// Nothing is persisted to disk; rings cap retention per session.
const COMMANDS_PER_SESSION = 50
// Output kept per command: first HEAD_LIMIT bytes plus a rolling tail.
const HEAD_LIMIT = 8 * 1024
const TAIL_LIMIT = 56 * 1024

export type Record = {
  info: Pty.Command
  head: string
  tail: string
}

export type BeginInput = {
  readonly ptyID: Pty.Command["ptyID"]
  readonly sessionID?: string
  readonly terminalTitle: string
  readonly command: string
  readonly cwd?: string
}

export interface Interface {
  readonly begin: (input: BeginInput) => Effect.Effect<Pty.Command>
  readonly append: (commandID: string, data: string) => Effect.Effect<void>
  readonly finish: (commandID: string, exitCode?: number) => Effect.Effect<Pty.Command | undefined>
  readonly list: (sessionID: string) => Effect.Effect<Pty.Command[]>
  readonly output: (sessionID: string, commandID: string) => Effect.Effect<Record | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PtyCapture") {}

const layer = Layer.sync(Service, () => {
  const records = new Map<string, Record>()
  const bySession = new Map<string, string[]>()

  const evict = (sessionID: string) => {
    const ids = bySession.get(sessionID)
    if (!ids) return
    while (ids.length > COMMANDS_PER_SESSION) {
      const oldest = ids.shift()
      if (oldest) records.delete(oldest)
    }
  }

  return Service.of({
    begin: Effect.fnUntraced(function* (input: BeginInput) {
      const info: Pty.Command = {
        id: "ptycmd_" + ascending(),
        ptyID: input.ptyID,
        sessionID: input.sessionID as Pty.Command["sessionID"],
        terminalTitle: input.terminalTitle,
        command: input.command,
        cwd: input.cwd,
        status: "running",
        time: { start: Date.now() },
        outputBytes: 0,
        truncated: false,
      }
      records.set(info.id, { info, head: "", tail: "" })
      if (input.sessionID) {
        const ids = bySession.get(input.sessionID) ?? []
        ids.push(info.id)
        bySession.set(input.sessionID, ids)
        evict(input.sessionID)
      }
      return info
    }),
    append: Effect.fnUntraced(function* (commandID: string, data: string) {
      const record = records.get(commandID)
      if (!record || record.info.status !== "running") return
      record.info = { ...record.info, outputBytes: record.info.outputBytes + data.length }
      if (record.head.length < HEAD_LIMIT) {
        const take = Math.min(HEAD_LIMIT - record.head.length, data.length)
        record.head += data.slice(0, take)
        data = data.slice(take)
      }
      if (!data) return
      record.tail += data
      if (record.tail.length > TAIL_LIMIT) {
        record.tail = record.tail.slice(record.tail.length - TAIL_LIMIT)
        record.info = { ...record.info, truncated: true }
      }
    }),
    finish: Effect.fnUntraced(function* (commandID: string, exitCode?: number) {
      const record = records.get(commandID)
      if (!record) return undefined
      record.info = {
        ...record.info,
        status: "completed",
        exitCode,
        time: { ...record.info.time, end: Date.now() },
      }
      return record.info
    }),
    list: Effect.fnUntraced(function* (sessionID: string) {
      const ids = bySession.get(sessionID) ?? []
      return ids.flatMap((id) => {
        const record = records.get(id)
        return record ? [record.info] : []
      })
    }),
    output: Effect.fnUntraced(function* (sessionID: string, commandID: string) {
      const record = records.get(commandID)
      if (!record) return undefined
      if (record.info.sessionID !== sessionID) return undefined
      return record
    }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
