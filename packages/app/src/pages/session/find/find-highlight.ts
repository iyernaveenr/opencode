export const FIND_HIGHLIGHT = "oc-find"
export const FIND_ACTIVE_HIGHLIGHT = "oc-find-active"

export function highlightSupported() {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined"
}

function visible(node: Text) {
  const parent = node.parentElement
  if (!parent) return false
  const tag = parent.tagName
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return false
  return !parent.closest("[hidden], [aria-hidden='true']")
}

/** Ranges for every occurrence of `pattern` in the text nodes under `root`, in document order. */
export function textRanges(root: Element, pattern: RegExp): Range[] {
  const result: Range[] = []
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"
  const re = new RegExp(pattern.source, flags)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data || !visible(node)) continue
    for (const hit of node.data.matchAll(re)) {
      if (hit[0].length === 0) continue
      const range = root.ownerDocument.createRange()
      range.setStart(node, hit.index)
      range.setEnd(node, hit.index + hit[0].length)
      result.push(range)
    }
  }
  return result
}

/** The ordinal-th occurrence inside `element`, clamped to the last one rendered markdown left. */
export function activeRange(element: Element, pattern: RegExp, ordinal: number) {
  const ranges = textRanges(element, pattern)
  if (ranges.length === 0) return undefined
  return ranges[Math.min(Math.max(ordinal, 0), ranges.length - 1)]
}

export function applyFindHighlights(input: { scope: Element; pattern: RegExp | undefined; active?: Range }) {
  if (!highlightSupported()) return
  if (!input.pattern) {
    clearFindHighlights()
    return
  }
  const all = new Highlight(...textRanges(input.scope, input.pattern))
  CSS.highlights.set(FIND_HIGHLIGHT, all)
  const active = new Highlight(...(input.active ? [input.active] : []))
  active.priority = 1
  CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT, active)
}

export function clearFindHighlights() {
  if (!highlightSupported()) return
  CSS.highlights.delete(FIND_HIGHLIGHT)
  CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT)
}

/** Scroll `scroller` so `range` sits in the middle of the viewport. */
export function scrollRangeIntoView(scroller: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect()
  const box = scroller.getBoundingClientRect()
  const top = scroller.scrollTop + (rect.top - box.top) - scroller.clientHeight / 2 + rect.height / 2
  scroller.scrollTo({ top: Math.max(0, top), behavior: "auto" })
}
