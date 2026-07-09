// Pure predicate for detecting when a NEW hand has started, from consecutive
// `handNumber` values seen in table_state broadcasts. Used by TableRoom.tsx
// to decide when per-hand-only client UI state (e.g. the "Folded" / "Called" /
// "Raised" last-action label shown under a seat) must be cleared.
//
// This must be derived from `table_state`, which the server broadcasts to
// EVERY socket in the room — seated, spectating, excluded from the current
// hand (e.g. an eliminated Sit & Go player still watching), or reconnecting —
// unlike `deal_cards`, which is private and only reaches players actually
// dealt into that specific hand. Keying the reset off deal_cards alone left
// spectators, excluded players, and some reconnecting players with a stale
// action label from the previous hand that never cleared.
export function didNewHandStart(
  prevHandNumber: number | null,
  incomingHandNumber: number | null,
): boolean {
  // A null incoming handNumber means no hand is running right now (between
  // hands) — that is not a new hand starting, so previous-hand action labels
  // are deliberately left alone until the next hand actually deals in.
  return incomingHandNumber !== null && incomingHandNumber !== prevHandNumber
}
