export type TabGroup = {
  id: string
  name: string
  color: number
  tabs: string[]
}

export type TabGroups = Record<string, TabGroup>

const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444"]

export function tabGroupColor(index: number) {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length]
}

export function groupForTab(groups: TabGroups, key: string) {
  return Object.values(groups).find((group) => group.tabs.includes(key))
}

export function createTabGroup(groups: TabGroups, id: string, name: string): TabGroups {
  const used = new Set(Object.values(groups).map((group) => group.color))
  const color = PALETTE.findIndex((_, index) => !used.has(index))
  return {
    ...groups,
    [id]: { id, name: name.trim(), color: color === -1 ? Object.keys(groups).length : color, tabs: [] },
  }
}

export function removeTabFromGroups(groups: TabGroups, key: string): TabGroups {
  return Object.fromEntries(
    Object.values(groups).flatMap((group) => {
      if (!group.tabs.includes(key)) return [[group.id, group]]
      const tabs = group.tabs.filter((item) => item !== key)
      return tabs.length === 0 ? [] : [[group.id, { ...group, tabs }]]
    }),
  )
}

export function assignTabGroup(groups: TabGroups, key: string, groupID: string | undefined): TabGroups {
  const next = removeTabFromGroups(groups, key)
  if (!groupID) return next
  const group = next[groupID] ?? groups[groupID]
  if (!group) return next
  return { ...next, [groupID]: { ...group, tabs: [...group.tabs.filter((item) => item !== key), key] } }
}

/** Keep only members that still have a tab; groups left empty disappear. */
export function pruneTabGroups(groups: TabGroups, keys: Set<string>): TabGroups {
  return Object.fromEntries(
    Object.values(groups).flatMap((group) => {
      const tabs = group.tabs.filter((key) => keys.has(key))
      if (tabs.length === 0) return []
      return [[group.id, tabs.length === group.tabs.length ? group : { ...group, tabs }]]
    }),
  )
}
