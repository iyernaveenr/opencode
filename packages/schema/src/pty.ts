export * as Pty from "./pty"

import { Schema } from "effect"
import { optional } from "./schema"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, statics } from "./schema"
import { SessionID } from "./session-id"

const IDSchema = Schema.String.check(Schema.isStartsWith("pty")).pipe(Schema.brand("PtyID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => {
    const create = () => schema.make("pty_" + ascending())
    return {
      create,
      ascending: (id?: string) => (id === undefined ? create() : schema.make(id)),
    }
  }),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  pid: NonNegativeInt,
  exitCode: optional(NonNegativeInt),
  // Owning chat session; absent = legacy workspace-scoped terminal.
  sessionID: optional(SessionID),
}).annotate({ identifier: "Pty" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Created = define({ type: "pty.created", schema: { info: Info } })
const Updated = define({ type: "pty.updated", schema: { info: Info } })
const Exited = define({ type: "pty.exited", schema: { id: ID, exitCode: NonNegativeInt } })
const Deleted = define({ type: "pty.deleted", schema: { id: ID } })
export const Event = { Created, Updated, Exited, Deleted, Definitions: inventory(Created, Updated, Exited, Deleted) }

export const CreateInput = Schema.Struct({
  command: optional(Schema.String),
  args: optional(Schema.Array(Schema.String)),
  cwd: optional(Schema.String),
  title: optional(Schema.String),
  env: optional(Schema.Record(Schema.String, Schema.String)),
  sessionID: optional(SessionID),
})
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const UpdateInput = Schema.Struct({
  title: optional(Schema.String),
  size: optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
})
export interface UpdateInput extends Schema.Schema.Type<typeof UpdateInput> {}

// One shell command captured via OSC 133 shell integration. Output bodies live in the
// capture store, not on the event bus.
export const Command = Schema.Struct({
  id: Schema.String,
  ptyID: ID,
  sessionID: optional(SessionID),
  terminalTitle: Schema.String,
  command: Schema.String,
  cwd: optional(Schema.String),
  status: Schema.Literals(["running", "completed"]),
  exitCode: optional(NonNegativeInt),
  time: Schema.Struct({ start: Schema.Number, end: optional(Schema.Number) }),
  outputBytes: NonNegativeInt,
  truncated: Schema.Boolean,
}).annotate({ identifier: "PtyCommand" })
export interface Command extends Schema.Schema.Type<typeof Command> {}

const CommandStarted = define({ type: "pty.command.started", schema: { command: Command } })
const CommandFinished = define({ type: "pty.command.finished", schema: { command: Command } })
export const CommandEvent = {
  Started: CommandStarted,
  Finished: CommandFinished,
  Definitions: inventory(CommandStarted, CommandFinished),
}
