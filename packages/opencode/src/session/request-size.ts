import type { ModelMessage } from "ai"

// Anthropic rejects request bodies above 32 MB with HTTP 413 regardless of token count; the
// system prompt, tool definitions and JSON framing come on top of the messages, hence the margin.
export const REQUEST_BYTES_MAX = 24 * 1024 * 1024

const REMOVED = "[image removed: older attachment dropped to keep the request under the provider size limit]"

type Slot = {
  bytes: number
  remove: () => void
}

type Loose = Record<string, unknown>

const isRecord = (value: unknown): value is Loose => typeof value === "object" && value !== null

function inlineBytes(value: unknown): number {
  if (typeof value === "string") return value.length
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Math.ceil(value.byteLength / 3) * 4
  return 0
}

function textBytes(value: unknown): number {
  return typeof value === "string" ? value.length : 0
}

/**
 * Estimates the serialized size of a request and, when it exceeds `budget`, replaces inline
 * media (user attachments and tool-result images) with a text placeholder, oldest first, until
 * it fits. Text is never dropped; token overflow stays the job of compaction. Returns the input
 * array itself when it already fits.
 */
export function trimMedia(messages: ModelMessage[], budget = REQUEST_BYTES_MAX) {
  let total = 0
  const slots: Slot[] = []

  const next = messages.map((message) => {
    if (typeof message.content === "string") {
      total += message.content.length
      return message
    }
    const content: unknown[] = message.content.map((part) => (isRecord(part) ? { ...part } : part))
    for (let i = 0; i < content.length; i++) {
      const part = content[i]
      if (!isRecord(part)) continue
      if (part.type === "text" || part.type === "reasoning") {
        total += textBytes(part.text)
        continue
      }
      if (part.type === "image" || part.type === "file") {
        const bytes = inlineBytes(part.type === "image" ? part.image : part.data)
        total += bytes
        if (bytes === 0) continue
        const index = i
        slots.push({
          bytes,
          remove: () => {
            content[index] = { type: "text", text: REMOVED }
          },
        })
        continue
      }
      if (part.type === "tool-call") {
        total += JSON.stringify(part.input ?? null).length
        continue
      }
      if (part.type !== "tool-result" || !isRecord(part.output)) continue
      const output = part.output
      if (output.type === "text" || output.type === "error-text") {
        total += textBytes(output.value)
        continue
      }
      if (output.type !== "content" || !Array.isArray(output.value)) {
        total += JSON.stringify(output.value ?? null).length
        continue
      }
      const value: unknown[] = output.value.map((item) => (isRecord(item) ? { ...item } : item))
      part.output = { ...output, value }
      for (let j = 0; j < value.length; j++) {
        const item = value[j]
        if (!isRecord(item)) continue
        if (item.type === "text") {
          total += textBytes(item.text)
          continue
        }
        if (item.type !== "media") continue
        const bytes = inlineBytes(item.data)
        total += bytes
        if (bytes === 0) continue
        const index = j
        slots.push({
          bytes,
          remove: () => {
            value[index] = { type: "text", text: REMOVED }
          },
        })
      }
    }
    // Parts were only shallow-copied or swapped for text parts, so the shape still matches.
    return { ...message, content } as ModelMessage
  })

  if (total <= budget) return { messages, removed: 0, bytes: total }

  let removed = 0
  for (const slot of slots) {
    if (total <= budget) break
    slot.remove()
    total -= slot.bytes - REMOVED.length
    removed++
  }
  return { messages: next, removed, bytes: total }
}
