import { describe, expect, test } from "bun:test"
import { activeRange, applyFindHighlights, highlightSupported, textRanges } from "./find-highlight"
import { findPattern } from "./find-matches"

const findPatternForTest = (query: string) => findPattern(query)!

const mount = (html: string) => {
  const root = document.createElement("div")
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe("find highlight ranges", () => {
  test("finds every visible occurrence in document order", () => {
    const root = mount(
      `<p>Alpha <b>alpha</b></p><pre><code>ALPHA = 1</code></pre><span hidden>alpha</span><div aria-hidden="true">alpha</div>`,
    )
    const ranges = textRanges(root, findPatternForTest("alpha"))
    expect(ranges.map((range) => range.toString())).toEqual(["Alpha", "alpha", "ALPHA"])
    expect(ranges[1]?.startContainer.parentElement?.tagName).toBe("B")
    root.remove()
  })

  test("picks the ordinal-th occurrence and clamps past the end", () => {
    const root = mount(`<p>one alpha two alpha</p>`)
    const pattern = findPatternForTest("alpha")
    expect(activeRange(root, pattern, 1)?.startOffset).toBe(14)
    expect(activeRange(root, pattern, 5)?.startOffset).toBe(14)
    expect(activeRange(root, findPatternForTest("beta"), 0)).toBeUndefined()
    root.remove()
  })

  test("is a no-op where the CSS Highlight API is missing", () => {
    expect(highlightSupported()).toBe(false)
    const root = mount(`<p>alpha</p>`)
    expect(() => applyFindHighlights({ scope: root, pattern: findPatternForTest("alpha") })).not.toThrow()
    root.remove()
  })
})
