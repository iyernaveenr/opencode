import { describe, expect, test } from "bun:test"
import {
  assignTabGroup,
  createTabGroup,
  groupForTab,
  pruneTabGroups,
  removeTabFromGroups,
  tabGroupColor,
  type TabGroups,
} from "./groups"

const seed = (): TabGroups => {
  const created = createTabGroup(createTabGroup({}, "g1", " Models "), "g2", "Docs")
  return assignTabGroup(assignTabGroup(assignTabGroup(created, "a", "g1"), "b", "g1"), "c", "g2")
}

describe("tab groups", () => {
  test("creates groups with trimmed names and distinct colors", () => {
    const groups = seed()
    expect(groups.g1.name).toBe("Models")
    expect(groups.g1.color).not.toBe(groups.g2.color)
    expect(tabGroupColor(groups.g1.color)).toMatch(/^#/)
  })

  test("a tab belongs to at most one group", () => {
    const groups = assignTabGroup(seed(), "a", "g2")
    expect(groups.g1.tabs).toEqual(["b"])
    expect(groups.g2.tabs).toEqual(["c", "a"])
    expect(groupForTab(groups, "a")?.id).toBe("g2")
  })

  test("removing the last member deletes the group", () => {
    const groups = removeTabFromGroups(seed(), "c")
    expect(groups.g2).toBeUndefined()
    expect(groups.g1.tabs).toEqual(["a", "b"])
    expect(assignTabGroup(groups, "a", undefined).g1.tabs).toEqual(["b"])
  })

  test("assigning to an unknown group only detaches the tab", () => {
    const groups = assignTabGroup(seed(), "a", "missing")
    expect(groupForTab(groups, "a")).toBeUndefined()
    expect(Object.keys(groups).sort()).toEqual(["g1", "g2"])
  })

  test("prune drops members without tabs and empty groups", () => {
    const groups = pruneTabGroups(seed(), new Set(["a"]))
    expect(Object.keys(groups)).toEqual(["g1"])
    expect(groups.g1.tabs).toEqual(["a"])
    const same = seed()
    expect(pruneTabGroups(same, new Set(["a", "b", "c"])).g1).toBe(same.g1)
  })
})
