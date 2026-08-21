import { Effect, Schema } from "effect"
import { PtyCapture } from "@opencode-ai/core/pty/capture"
import { Config } from "@/config/config"
import * as Tool from "./tool"

const OUTPUT_LIMIT = 16_000

type Meta = { count?: number; exitCode?: number; truncated?: boolean }

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "output"]).annotate({
    description: "'list' shows this session's recent terminal commands; 'output' fetches one command's output",
  }),
  commandID: Schema.optional(Schema.String).annotate({
    description: "Command id from 'list' (required for action 'output')",
  }),
})

function when(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false })
}

function line(command: import("@opencode-ai/schema/pty").Pty.Command) {
  const status = command.status === "running" ? "running" : `exit ${command.exitCode ?? "?"}`
  const duration = command.time.end ? ` ${((command.time.end - command.time.start) / 1000).toFixed(1)}s` : ""
  const text = command.command.length > 120 ? command.command.slice(0, 120) + "..." : command.command
  return `[${command.id}] ${when(command.time.start)}${duration} (${status}) ${command.cwd ?? ""}$ ${text}`
}

export const TerminalTool = Tool.define(
  "terminal",
  Effect.gen(function* () {
    const capture = yield* PtyCapture.Service
    const config = yield* Config.Service
    return {
      description: [
        "Inspect commands the user ran in this chat session's integrated terminals.",
        "Use action 'list' to see recent commands with exit codes, then action 'output' with a commandID to read a command's captured output.",
        "Output is bounded; truncated output is marked. Only this session's terminals are visible.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: { action: "list" | "output"; commandID?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const mode = cfg.terminal_context ?? "off"
          if (mode === "off")
            return {
              title: "terminal context disabled",
              output: "Terminal context is disabled (set terminal_context in config to enable).",
              metadata: {} as Meta,
            }

          if (params.action === "list") {
            const commands = yield* capture.list(ctx.sessionID)
            if (commands.length === 0)
              return {
                title: "no captured commands",
                output:
                  "No terminal commands captured for this session yet. Commands are captured only from this session's integrated terminals (bash shell integration).",
                metadata: { count: 0 },
              }
            const lines = commands.map(line)
            return {
              title: `${commands.length} terminal command(s)`,
              output: ["Most recent last:", ...lines].join("\n"),
              metadata: { count: commands.length },
            }
          }

          if (!params.commandID)
            return {
              title: "missing commandID",
              output: "action 'output' requires commandID (use action 'list' first).",
              metadata: {},
            }
          const record = yield* capture.output(ctx.sessionID, params.commandID)
          if (!record)
            return {
              title: "command not found",
              output: `No captured command ${params.commandID} in this session.`,
              metadata: {},
            }
          const gap = record.info.truncated ? "\n... (middle truncated) ...\n" : ""
          const full = record.head + gap + record.tail
          const clipped = full.length > OUTPUT_LIMIT
          const body = clipped ? full.slice(0, OUTPUT_LIMIT) : full
          const status = record.info.status === "running" ? "still running" : `exit ${record.info.exitCode ?? "?"}`
          return {
            title: record.info.command.slice(0, 60),
            output: [
              `$ ${record.info.command}`,
              `(${status}, cwd ${record.info.cwd ?? "unknown"}${record.info.truncated || clipped ? ", output truncated" : ""})`,
              body || "(no output)",
            ].join("\n"),
            metadata: { exitCode: record.info.exitCode, truncated: record.info.truncated || clipped },
          }
        }),
    }
  }),
)
