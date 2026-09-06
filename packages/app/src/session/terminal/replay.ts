// Where server replay starts when a terminal (re)connects. A stored stream cursor is
// only meaningful together with the screen snapshot it complements: with both, resume
// from the cursor; snapshot alone tails (-1); otherwise replay the full retained
// buffer (0) so scrollback survives snapshot loss (e.g. the session store swapping
// before the snapshot was persisted).
export function initialReplayCursor(stored: number | undefined, hasSnapshot: boolean): number {
  if (hasSnapshot) return stored ?? -1
  return 0
}
