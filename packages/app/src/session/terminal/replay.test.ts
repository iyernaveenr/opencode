import { describe, expect, test } from "bun:test"
import { initialReplayCursor } from "./replay"

describe("initialReplayCursor", () => {
  test("resumes from the cursor when the snapshot is present", () => {
    expect(initialReplayCursor(1234, true)).toBe(1234)
  })

  test("tails when only the snapshot is present", () => {
    expect(initialReplayCursor(undefined, true)).toBe(-1)
  })

  test("replays the full buffer when the snapshot is missing", () => {
    expect(initialReplayCursor(1234, false)).toBe(0)
    expect(initialReplayCursor(undefined, false)).toBe(0)
  })
})
