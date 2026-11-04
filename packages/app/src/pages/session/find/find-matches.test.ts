import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { findMatches, findPattern, startIndex, stepIndex } from "./find-matches"

// Fixtures carry only the fields the matcher reads.
/* oxlint-disable typescript-eslint/no-unsafe-type-assertion */
const user = (id: string) => ({ id, role: "user" }) as unknown as UserMessage
const assistant = (id: string, parentID: string) => ({ id, role: "assistant", parentID }) as unknown as AssistantMessage
const text = (id: string, messageID: string, value: string, extra: Partial<Part> = {}) =>
  ({ id, messageID, sessionID: "ses", type: "text", text: value, ...extra }) as unknown as Part
const reasoning = (id: string, messageID: string, value: string) =>
  ({ id, messageID, sessionID: "ses", type: "reasoning", text: value }) as unknown as Part
/* oxlint-enable typescript-eslint/no-unsafe-type-assertion */

const users = [user("u1"), user("u2"), user("u3")]
const assistants = new Map<string, AssistantMessage[]>([
  ["u1", [assistant("a1", "u1")]],
  ["u2", [assistant("a2", "u2"), assistant("a3", "u2")]],
])
const parts = new Map<string, Part[]>([
  ["u1", [text("p0", "u1", "<reminder> Alpha </reminder>", { synthetic: true }), text("p1", "u1", "Where is alpha?")]],
  ["a1", [reasoning("p2", "a1", "alpha alpha"), text("p3", "a1", "Alpha is in file.ts"), text("p4", "a1", "   ")]],
  ["u2", [text("p5", "u2", "unrelated")]],
  ["a2", [text("p6", "a2", "tool output mentions ALPHA")]],
  ["a3", [text("p7", "a3", "a.b (alpha)")]],
  ["u3", [text("p8", "u3", "nothing here")]],
])

const run = (query: string, options: { reasoning?: boolean } = {}) =>
  findMatches({
    userMessages: users,
    assistants: (id) => assistants.get(id) ?? [],
    parts: (id) => parts.get(id) ?? [],
    query,
    reasoning: options.reasoning ?? false,
  })

describe("findMatches", () => {
  test("matches rendered text case-insensitively in timeline order", () => {
    const matches = run("alpha")
    expect(matches.map((match) => [match.partID, match.index, match.ordinal])).toEqual([
      ["p1", 9, 0],
      ["p3", 0, 0],
      ["p6", 21, 0],
      ["p7", 5, 0],
    ])
    expect(matches.every((match) => match.length === 5)).toBe(true)
    expect(matches[0]?.role).toBe("user")
    expect(matches[1]?.userMessageID).toBe("u1")
    expect(matches[3]?.messageID).toBe("a3")
  })

  test("skips synthetic prompt parts and includes reasoning only when shown", () => {
    expect(run("reminder")).toEqual([])
    const shown = run("alpha", { reasoning: true })
    expect(shown.filter((match) => match.partID === "p2").map((match) => match.ordinal)).toEqual([0, 1])
    expect(shown).toHaveLength(6)
  })

  test("treats the query as literal text", () => {
    expect(run("a.b (").map((match) => match.partID)).toEqual(["p7"])
    expect(run("   ")).toEqual([])
    expect(findPattern("")).toBeUndefined()
  })
})

describe("find navigation", () => {
  test("starts at the first match at or after the cursor turn", () => {
    const matches = run("alpha")
    expect(startIndex(matches, users, undefined)).toBe(0)
    expect(startIndex(matches, users, "u2")).toBe(2)
    expect(startIndex(matches, users, "u3")).toBe(0)
    expect(startIndex(matches, users, "missing")).toBe(0)
    expect(startIndex([], users, "u1")).toBe(-1)
  })

  test("steps with wrap-around", () => {
    expect(stepIndex(0, 4, 1)).toBe(1)
    expect(stepIndex(3, 4, 1)).toBe(0)
    expect(stepIndex(0, 4, -1)).toBe(3)
    expect(stepIndex(-1, 4, 1)).toBe(0)
    expect(stepIndex(-1, 4, -1)).toBe(3)
    expect(stepIndex(2, 0, 1)).toBe(-1)
  })
})
