import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Effect } from "effect"
import { trimMedia, fitMedia, shrinker, REQUEST_BYTES_MAX, type Media } from "../../src/session/request-size"

const png = (size: number) => `data:image/png;base64,${"A".repeat(size)}`

const user = (text: string, ...images: string[]): ModelMessage => ({
  role: "user",
  content: [
    { type: "text", text },
    ...images.map((image) => ({ type: "file" as const, data: image, mediaType: "image/png" })),
  ],
})

const toolResult = (id: string, text: string, ...images: string[]): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: id,
      toolName: "bash",
      output: {
        type: "content",
        value: [
          { type: "text", text },
          ...images.map((image) => ({
            type: "media" as const,
            data: image.slice(image.indexOf(",") + 1),
            mediaType: "image/png",
          })),
        ],
      },
    },
  ],
})

const mediaCount = (messages: ModelMessage[]) =>
  JSON.stringify(messages).match(/"type":"(file|image|media)"/g)?.length ?? 0

describe("request-size trimMedia", () => {
  test("returns the same array when the request fits", () => {
    const messages = [user("hello", png(100)), toolResult("t1", "ok", png(100))]
    const result = trimMedia(messages, 10_000)
    expect(result.messages).toBe(messages)
    expect(result.removed).toBe(0)
    expect(result.bytes).toBeGreaterThan(200)
  })

  test("drops the oldest media first until the request fits and keeps the text", () => {
    const messages = [
      user("first", png(1_000)),
      toolResult("t1", "render done", png(1_000), png(1_000)),
      user("last question", png(1_000)),
    ]
    const result = trimMedia(messages, 2_500)
    expect(result.removed).toBe(2)
    expect(result.bytes).toBeLessThanOrEqual(2_500)
    expect(mediaCount(result.messages)).toBe(2)
    // Original input is untouched.
    expect(mediaCount(messages)).toBe(4)

    const [first, tool, last] = result.messages
    expect(JSON.stringify(first)).toContain("image removed")
    expect(JSON.stringify(first)).toContain("first")
    const types = JSON.stringify(tool).match(/"type":"(text|media)"/g)
    expect(types).toEqual(['"type":"text"', '"type":"text"', '"type":"media"'])
    expect(JSON.stringify(last)).not.toContain("image removed")
    expect(JSON.stringify(last)).toContain("last question")
  })

  test("drops every image rather than failing when even the newest does not fit", () => {
    const messages = [user("a", png(5_000)), user("b", png(5_000))]
    const result = trimMedia(messages, 1_000)
    expect(result.removed).toBe(2)
    expect(mediaCount(result.messages)).toBe(0)
    expect(result.bytes).toBeLessThan(1_000)
  })

  test("counts binary payloads at their base64 size and ignores remote URLs", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: new Uint8Array(3_000), mediaType: "image/png" },
          { type: "image", image: new URL("https://example.com/a.png") },
        ],
      },
    ]
    const result = trimMedia(messages, 1_000)
    expect(result.removed).toBe(1)
    expect(JSON.stringify(result.messages)).toContain("example.com")
  })

  test("default budget stays under the 32 MB provider cap", () => {
    expect(REQUEST_BYTES_MAX).toBeLessThan(32 * 1024 * 1024)
  })
})

describe("request-size fitMedia", () => {
  // Stands in for the image service: every image becomes a 50-byte JPEG data URL.
  const tiny = (_item: Media) =>
    Effect.succeed({ data: `data:image/jpeg;base64,${"j".repeat(50 - 23)}`, mediaType: "image/jpeg" })

  test("shrinks old images before dropping anything and keeps the newest two untouched", async () => {
    const messages = [
      user("first", png(1_000)),
      toolResult("t1", "render", png(1_000), png(1_000)),
      user("last", png(1_000)),
    ]
    const result = await Effect.runPromise(fitMedia(messages, 2_600, tiny))
    expect(result.removed).toBe(0)
    expect(result.shrunk).toBe(2)
    expect(result.bytes).toBeLessThanOrEqual(2_600)
    expect(mediaCount(result.messages)).toBe(4)
    expect(mediaCount(messages)).toBe(4)

    const [first, tool, last] = result.messages
    expect(JSON.stringify(first)).toContain("image/jpeg")
    expect(JSON.stringify(last)).not.toContain("image/jpeg")
    const text = JSON.stringify(tool)
    // First tool image shrunk (bare base64, jpeg type), second kept full size.
    expect(text).toContain('"mediaType":"image/jpeg"')
    expect(text).toContain('"mediaType":"image/png"')
    expect(text).not.toContain("data:image/jpeg")
  })

  test("drops only when shrinking is not enough, and newest images last", async () => {
    const messages = [user("a", png(1_000)), user("b", png(1_000)), user("c", png(1_000))]
    // Shrinking the one eligible image (the newest two are kept) is not enough; the drop stage
    // then skips the already-shrunk image and removes the next oldest full-size one.
    const result = await Effect.runPromise(fitMedia(messages, 1_200, tiny))
    expect(result.shrunk).toBe(1)
    expect(result.removed).toBe(1)
    expect(result.bytes).toBeLessThanOrEqual(1_200)
    expect(mediaCount(result.messages)).toBe(2)
    expect(JSON.stringify(result.messages[0])).toContain("image/jpeg")
    expect(JSON.stringify(result.messages[1])).toContain("image removed")
    expect(JSON.stringify(result.messages[2])).toContain("image/png")
  })

  test("falls back to dropping when no shrinker is available or it declines", async () => {
    const messages = [user("a", png(1_000)), user("b", png(1_000)), user("c", png(1_000)), user("d", png(1_000))]
    const none = await Effect.runPromise(fitMedia(messages, 1_400))
    expect(none.shrunk).toBe(0)
    expect(none.removed).toBe(3)
    const declines = await Effect.runPromise(fitMedia(messages, 1_400, () => Effect.succeed(undefined)))
    expect(declines.shrunk).toBe(0)
    expect(declines.removed).toBe(3)
  })

  test("returns the input untouched when it fits", async () => {
    const messages = [user("a", png(100))]
    const result = await Effect.runPromise(fitMedia(messages, 10_000, tiny))
    expect(result.messages).toBe(messages)
    expect(result.shrunk).toBe(0)
  })

  test("shrinker caches by original bytes and treats service errors as a decline", async () => {
    let calls = 0
    const shrink = shrinker({
      normalize: (input) => Effect.succeed(input),
      shrink: (input) =>
        Effect.sync(() => {
          calls++
          if (input.url.includes("BAD")) throw new Error("decode")
          return { ...input, url: "data:image/jpeg;base64,xx", mime: "image/jpeg" }
        }),
    })
    const ok: Media = { data: png(200), mediaType: "image/png" }
    const bad: Media = { data: `data:image/png;base64,BAD${"A".repeat(200)}`, mediaType: "image/png" }
    const first = await Effect.runPromise(shrink(ok))
    const second = await Effect.runPromise(shrink(ok))
    expect(first).toEqual({ data: "data:image/jpeg;base64,xx", mediaType: "image/jpeg" })
    expect(second).toEqual(first)
    expect(await Effect.runPromise(shrink(bad))).toBeUndefined()
    expect(await Effect.runPromise(shrink(bad))).toBeUndefined()
    expect(calls).toBe(2)
  })
})
