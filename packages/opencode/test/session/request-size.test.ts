import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { trimMedia, REQUEST_BYTES_MAX } from "../../src/session/request-size"

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
