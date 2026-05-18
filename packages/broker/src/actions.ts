// Action ID allowlist. Adding a new action is an explicit, reviewed change to
// this list. Anything outside this set is rejected at /api/mint and at the box.
export const ACTION_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  "google.whoami",
]);

// Per-bearer TTL bounds enforced at /api/mint. Below the floor a bearer is
// likely to expire before the user pastes the slug; above the ceiling we widen
// the replay window on a leaked slug page screenshot.
export const ACTION_TTL_BOUNDS = { min: 60, max: 86400 } as const;

export function isActionAllowed(id: string): boolean {
  return ACTION_ALLOWLIST.has(id);
}
