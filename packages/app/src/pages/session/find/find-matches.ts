import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"

export type FindMatch = {
  userMessageID: string
  messageID: string
  partID: string
  role: "user" | "assistant"
  /** Position of this match among the matches inside the same part. */
  ordinal: number
  index: number
  length: number
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Case-insensitive literal pattern; undefined for an empty or whitespace-only query. */
export function findPattern(query: string) {
  if (!query.trim()) return undefined
  return new RegExp(escapeRegExp(query), "giu")
}

/** The text a part contributes to the timeline, mirroring what the renderer shows. */
export function searchableText(part: Part, options: { reasoning: boolean }) {
  if (part.type === "text") return part.text.trim() ? part.text : undefined
  if (part.type === "reasoning") return options.reasoning && part.text.trim() ? part.text : undefined
  return undefined
}

export function findMatches(input: {
  userMessages: readonly UserMessage[]
  assistants: (userMessageID: string) => readonly AssistantMessage[]
  parts: (messageID: string) => readonly Part[]
  query: string
  reasoning: boolean
}): FindMatch[] {
  const pattern = findPattern(input.query)
  if (!pattern) return []
  const result: FindMatch[] = []
  const collect = (userMessageID: string, messageID: string, role: FindMatch["role"], part: Part, text: string) => {
    let ordinal = 0
    for (const hit of text.matchAll(pattern)) {
      if (hit[0].length === 0) continue
      result.push({ userMessageID, messageID, partID: part.id, role, ordinal, index: hit.index, length: hit[0].length })
      ordinal += 1
    }
  }
  for (const user of input.userMessages) {
    // The user bubble renders only the first non-synthetic text part.
    const prompt = input.parts(user.id).find((part) => part.type === "text" && !part.synthetic)
    if (prompt?.type === "text") collect(user.id, user.id, "user", prompt, prompt.text)
    for (const assistant of input.assistants(user.id)) {
      for (const part of input.parts(assistant.id)) {
        const text = searchableText(part, { reasoning: input.reasoning })
        if (text !== undefined) collect(user.id, assistant.id, "assistant", part, text)
      }
    }
  }
  return result
}

/** First match at or after the turn the reader is looking at; wraps to the first match. */
export function startIndex(
  matches: readonly FindMatch[],
  userMessages: readonly UserMessage[],
  cursor: string | undefined,
) {
  if (matches.length === 0) return -1
  if (!cursor) return 0
  const position = new Map(userMessages.map((message, index) => [message.id, index] as const))
  const from = position.get(cursor)
  if (from === undefined) return 0
  const index = matches.findIndex((match) => (position.get(match.userMessageID) ?? -1) >= from)
  return index === -1 ? 0 : index
}

export function stepIndex(current: number, total: number, delta: 1 | -1) {
  if (total <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : total - 1
  return (((current + delta) % total) + total) % total
}
