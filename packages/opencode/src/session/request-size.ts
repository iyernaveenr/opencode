import type { ModelMessage } from "ai"
import { Effect } from "effect"
import type { Image } from "@/image/image"

// Anthropic rejects request bodies above 32 MB with HTTP 413 regardless of token count; the
// system prompt, tool definitions and JSON framing come on top of the messages, hence the margin.
export const REQUEST_BYTES_MAX = 24 * 1024 * 1024
// The newest images are the ones the model is most likely working from; they keep full quality.
export const KEEP_FULL_QUALITY = 2
// Old screenshots stay legible at this size while costing roughly a tenth of a full PNG capture.
export const SHRINK_LIMITS: Image.Limits = { maxWidth: 1024, maxHeight: 1024, maxBase64Bytes: 160_000 }
const CACHE_LIMIT = 512

const REMOVED = "[image removed: older attachment dropped to keep the request under the provider size limit]"

export type Media = { data: string; mediaType: string }
export type Shrink = (item: Media) => Effect.Effect<Media | undefined>

type Slot = {
  bytes: number
  read: () => Media | undefined
  write: (media: Media) => void
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

// Walks a request once: shallow-copies the message parts so they can be rewritten without
// touching the originals, sums the serialized size, and records every inline image in order.
function scan(messages: ModelMessage[]) {
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
        const key = part.type === "image" ? "image" : "data"
        const bytes = inlineBytes(part[key])
        total += bytes
        if (bytes === 0) continue
        const index = i
        slots.push({
          bytes,
          read: () => {
            const data = part[key]
            const mediaType = part.mediaType
            // Only data URLs can be re-encoded; a data URL carries its own media type.
            if (typeof data !== "string" || !data.startsWith("data:")) return undefined
            return { data, mediaType: typeof mediaType === "string" ? mediaType : data.slice(5, data.indexOf(";")) }
          },
          write: (media) => {
            part[key] = media.data
            part.mediaType = media.mediaType
          },
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
          read: () => {
            const data = item.data
            const mediaType = item.mediaType
            if (typeof data !== "string" || typeof mediaType !== "string") return undefined
            // Tool-result media carries bare base64; present it as a data URL to the encoder.
            return { data: `data:${mediaType};base64,${data}`, mediaType }
          },
          write: (media) => {
            item.data = media.data.slice(media.data.indexOf(",") + 1)
            item.mediaType = media.mediaType
          },
          remove: () => {
            value[index] = { type: "text", text: REMOVED }
          },
        })
      }
    }
    // Parts were only shallow-copied or swapped for text parts, so the shape still matches.
    return { ...message, content } as ModelMessage
  })

  return { next, total, slots }
}

function drop(state: { total: number }, slots: Slot[], budget: number) {
  let removed = 0
  for (const slot of slots) {
    if (state.total <= budget) break
    // An image already shrunk below the placeholder's size gains nothing by being dropped.
    if (slot.bytes <= REMOVED.length) continue
    slot.remove()
    state.total -= slot.bytes - REMOVED.length
    slot.bytes = REMOVED.length
    removed++
  }
  return removed
}

/**
 * Synchronous fallback: when the request exceeds `budget`, replaces inline media with a text
 * placeholder, oldest first, until it fits. Returns the input array itself when it already fits.
 */
export function trimMedia(messages: ModelMessage[], budget = REQUEST_BYTES_MAX) {
  const scanned = scan(messages)
  if (scanned.total <= budget) return { messages, removed: 0, bytes: scanned.total }
  const state = { total: scanned.total }
  const removed = drop(state, scanned.slots, budget)
  return { messages: scanned.next, removed, bytes: state.total }
}

/**
 * Fits a request under `budget` while giving up as little as possible: first re-encodes old
 * images smaller (newest `keep` stay untouched), and only if that is not enough drops the
 * oldest ones. Text is never dropped; token overflow stays the job of compaction.
 */
export const fitMedia = Effect.fn("RequestSize.fit")(function* (
  messages: ModelMessage[],
  budget: number = REQUEST_BYTES_MAX,
  shrink?: Shrink,
  keep: number = KEEP_FULL_QUALITY,
) {
  const scanned = scan(messages)
  if (scanned.total <= budget) return { messages, shrunk: 0, removed: 0, bytes: scanned.total }
  const state = { total: scanned.total }
  let shrunk = 0
  if (shrink) {
    const candidates = scanned.slots.slice(0, Math.max(0, scanned.slots.length - keep))
    for (const slot of candidates) {
      if (state.total <= budget) break
      const media = slot.read()
      if (!media) continue
      const smaller = yield* shrink(media)
      if (!smaller || smaller.data.length >= media.data.length) continue
      const bytes = slot.bytes - (media.data.length - smaller.data.length)
      slot.write(smaller)
      state.total -= slot.bytes - bytes
      slot.bytes = bytes
      shrunk++
    }
  }
  const removed = state.total > budget ? drop(state, scanned.slots, budget) : 0
  return { messages: scanned.next, shrunk, removed, bytes: state.total }
})

/** Builds a Shrink backed by the image service with a bounded cache keyed by the original bytes. */
export function shrinker(image: Image.Interface, limits: Image.Limits = SHRINK_LIMITS): Shrink {
  const cache = new Map<string, Media | undefined>()
  return (item) =>
    Effect.gen(function* () {
      const hit = cache.get(item.data)
      if (hit !== undefined || cache.has(item.data)) return hit
      const result = yield* image.shrink({ url: item.data, mime: item.mediaType }, limits).pipe(
        Effect.map((out) => ({ data: out.url, mediaType: out.mime })),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(item.data, result)
      return result
    })
}
