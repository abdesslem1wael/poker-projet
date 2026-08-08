// Pure state machine for the All-in confirmation step in TableRoom.tsx.
//
// The All-in button must never emit `player_action` directly — clicking it
// only opens a confirmation ("REQUEST"); the actual action is sent by the
// caller only when `canSubmitAllIn` allows it, immediately followed by a
// "CONFIRM" dispatch. Keeping the emit decision in the caller (rather than
// inside the reducer) means a double-click on Confirm can never fire the
// socket event twice: the second click reads `sending: true` from state
// still in the closure of the first render and bails out via `canSubmitAllIn`
// before dispatching.
//
// "ACTION_UNAVAILABLE" is dispatched whenever the player is no longer in a
// position to act (turn changed, hand ended, they folded/went all-in via
// another path, etc.) — this is what auto-closes the confirmation instead of
// leaving it stranded open on a stale turn.
export interface AllInConfirmState {
  open: boolean
  sending: boolean
}

export type AllInConfirmEvent =
  | { type: 'REQUEST' }             // All-in button clicked
  | { type: 'CANCEL' }              // Cancel clicked
  | { type: 'CONFIRM' }             // Confirm All-in clicked (caller must gate with canSubmitAllIn first)
  | { type: 'ERROR' }               // server rejected the action (socket_error while sending)
  | { type: 'ACTION_UNAVAILABLE' }  // turn changed / hand ended / no longer allowed to act

export const initialAllInConfirmState: AllInConfirmState = { open: false, sending: false }

export function allInConfirmReducer(state: AllInConfirmState, event: AllInConfirmEvent): AllInConfirmState {
  switch (event.type) {
    case 'REQUEST':
      return { open: true, sending: false }
    case 'CANCEL':
      return state.open || state.sending ? { open: false, sending: false } : state
    case 'CONFIRM':
      return state.sending ? state : { open: true, sending: true }
    case 'ERROR':
      return state.sending ? { ...state, sending: false } : state
    case 'ACTION_UNAVAILABLE':
      return state.open || state.sending ? { open: false, sending: false } : state
    default:
      return state
  }
}

// Guards the actual `player_action` emit. Must be checked immediately before
// sending — a stale closure reading `sending: false` from a previous render
// is exactly the double-submit this exists to prevent.
export function canSubmitAllIn(state: AllInConfirmState): boolean {
  return state.open && !state.sending
}
