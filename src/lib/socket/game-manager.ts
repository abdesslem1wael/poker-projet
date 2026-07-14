// Server-side only — never import from client code.
// All hand logic runs here; no card data leaves this module except via
// getPlayerHoleCards() which is called per-socket to send private cards.
import { createDeck, shuffle } from '../poker/deck'
import type { Card } from '../poker/types'
import type {
  PlayerHandState,
  PlayerStatus,
  HandState,
  TableGame,
  HandEndedData,
} from './game-types'
import type {
  BettingAction,
  PublicHandState,
  PublicPlayerHandState,
} from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = any

export type ActionResult =
  | { ok: true; handEnded?: false; runout?: false }
  | { ok: true; handEnded?: false; runout: true }
  | { ok: true; handEnded: true; data: HandEndedData }
  | { error: string }

export type RunoutStreetResult =
  | { ok: true; phase: string; communityCards: Card[]; handEnded: false }
  | { ok: true; handEnded: true; data: HandEndedData }
  | { error: string }

export class GameManager {
  private games = new Map<string, TableGame>()

  private getOrCreate(tableId: string): TableGame {
    let g = this.games.get(tableId)
    if (!g) {
      g = { tableId, dealerSeatNumber: 0, handCount: 0, handState: null }
      this.games.set(tableId, g)
    }
    return g
  }

  hasActiveHand(tableId: string): boolean {
    return this.games.get(tableId)?.handState != null
  }

  getPublicHandState(tableId: string): PublicHandState | null {
    const s = this.games.get(tableId)?.handState
    if (!s) return null
    const actor = s.currentActorIndex >= 0 ? s.players[s.currentActorIndex] : null
    return {
      handNumber: s.handNumber,
      phase: s.phase,
      pot: s.pot,
      currentBet: s.currentBet,
      minRaise: s.minRaise,
      currentTurnPlayerId: actor?.playerId ?? null,
      dealerSeatNumber: s.dealerSeatNumber,
      smallBlindSeatNumber: s.smallBlindSeatNumber,
      bigBlindSeatNumber: s.bigBlindSeatNumber,
      communityCards: s.communityCards as PublicHandState['communityCards'],
      players: s.players.map(
        (p): PublicPlayerHandState => ({
          playerId: p.playerId,
          seatNumber: p.seatNumber,
          stack: p.stack,
          roundContribution: p.roundContribution,
          totalContributed: p.totalContributed,
          playerPhase: p.status,
          hasActedThisRound: p.hasActedThisRound,
        }),
      ),
    }
  }

  // Returns all non-folded players' hole cards for a runout reveal.
  getAllHoleCards(tableId: string): Array<{ playerId: string; cards: [Card, Card] }> {
    const s = this.games.get(tableId)?.handState
    if (!s) return []
    return s.players
      .filter(p => p.status !== 'folded')
      .map(p => ({ playerId: p.playerId, cards: [p.holeCards[0], p.holeCards[1]] as [Card, Card] }))
  }

  // Returns null if the player has no hole cards (spectator, or no active hand).
  getPlayerHoleCards(tableId: string, playerId: string): [Card, Card] | null {
    const s = this.games.get(tableId)?.handState
    if (!s) return null
    return s.players.find(p => p.playerId === playerId)?.holeCards ?? null
  }

  async startHand(
    tableId: string,
    seatedPlayers: Array<{ playerId: string; username: string; seatNumber: number }>,
    supabase: DB,
    smallBlind: number,
    bigBlind: number,
    // Sit & Go tables pass their tournament stacks here (sourced from
    // sit_go_registrations.current_stack) instead of the wallets table —
    // cash games omit this and keep the existing wallet-backed behavior.
    stackOverrides?: Map<string, number>,
    // Automatic rake only applies to cash games — a Sit & Go's house fee is
    // already taken out of the buy-in at registration (see register_sit_go),
    // so skimming from pots on top of that would double-charge players.
    rakeEnabled: boolean = true,
  ): Promise<{ ok: true } | { error: string }> {
    if (seatedPlayers.length < 2) {
      return { error: 'Need at least 2 seated players to start a hand' }
    }

    // Sort by seat number for a consistent, deterministic player order.
    const sorted = [...seatedPlayers].sort((a, b) => a.seatNumber - b.seatNumber)

    let stackMap: Map<string, number>
    if (stackOverrides) {
      stackMap = stackOverrides
    } else {
      // Load stacks from the wallets table (cash games).
      const { data: walletRows, error: walletErr } = await supabase
        .from('wallets')
        .select('user_id, chips')
        .in('user_id', sorted.map(p => p.playerId))

      if (walletErr) return { error: 'Failed to load player stacks' }

      stackMap = new Map<string, number>()
      for (const w of (walletRows as Array<{ user_id: string; chips: number }> | null) ?? []) {
        stackMap.set(w.user_id, w.chips)
      }
    }

    // Safety net: server.ts filters broke players before calling startHand,
    // but skip any that somehow arrive here with 0 chips.
    const active = sorted.filter(p => (stackMap.get(p.playerId) ?? 0) > 0)
    if (active.length < 2) return { error: 'Not enough players with chips to start' }
    const n2 = active.length

    const game = this.getOrCreate(tableId)

    // Rotate the dealer button.
    const seatNums = active.map(p => p.seatNumber)
    const dealerIdx = this.nextDealerIndex(game.dealerSeatNumber, seatNums)
    const dealerSeatNumber = active[dealerIdx].seatNumber

    // Determine SB, BB and first-to-act positions.
    let sbIdx: number
    let bbIdx: number
    let firstActorIdx: number
    if (n2 === 2) {
      // Heads-up: dealer = SB, SB acts first pre-flop.
      sbIdx = dealerIdx
      bbIdx = (dealerIdx + 1) % n2
      firstActorIdx = sbIdx
    } else {
      sbIdx = (dealerIdx + 1) % n2
      bbIdx = (dealerIdx + 2) % n2
      firstActorIdx = (dealerIdx + 3) % n2
    }

    // Create and shuffle a fresh deck.
    const deckCopy = [...shuffle(createDeck())]

    // Deal one card at a time starting from the SB position.
    const firstCards: Card[] = new Array(n2)
    const secondCards: Card[] = new Array(n2)
    for (let i = 0; i < n2; i++) firstCards[(sbIdx + i) % n2] = deckCopy.shift()!
    for (let i = 0; i < n2; i++) secondCards[(sbIdx + i) % n2] = deckCopy.shift()!

    const players: PlayerHandState[] = active.map((p, i) => ({
      playerId: p.playerId,
      username: p.username,
      seatNumber: p.seatNumber,
      stack: stackMap.get(p.playerId) ?? 0,
      roundContribution: 0,
      totalContributed: 0,
      status: 'active' as PlayerStatus,
      hasActedThisRound: false,
      holeCards: [firstCards[i], secondCards[i]],
    }))

    // Post small blind.
    const sbAmt = Math.min(smallBlind, players[sbIdx].stack)
    players[sbIdx].stack -= sbAmt
    players[sbIdx].roundContribution = sbAmt
    players[sbIdx].totalContributed = sbAmt
    if (players[sbIdx].stack === 0) players[sbIdx].status = 'all-in'

    // Post big blind.
    const bbAmt = Math.min(bigBlind, players[bbIdx].stack)
    players[bbIdx].stack -= bbAmt
    players[bbIdx].roundContribution = bbAmt
    players[bbIdx].totalContributed = bbAmt
    if (players[bbIdx].stack === 0) players[bbIdx].status = 'all-in'

    // Find the first active player starting from firstActorIdx.
    let actorIdx = firstActorIdx
    for (let i = 0; i < n2; i++) {
      if (players[actorIdx].status === 'active') break
      actorIdx = (actorIdx + 1) % n2
    }
    if (players[actorIdx].status !== 'active') actorIdx = -1

    game.handCount += 1

    const handState: HandState = {
      phase: 'PRE_FLOP',
      bigBlind,
      handNumber: game.handCount,
      startedAt: new Date(),
      deckRemaining: deckCopy,
      communityCards: [],
      players,
      dealerSeatNumber,
      smallBlindSeatNumber: active[sbIdx].seatNumber,
      bigBlindSeatNumber: active[bbIdx].seatNumber,
      pot: sbAmt + bbAmt,
      currentBet: bigBlind,
      minRaise: bigBlind,
      currentActorIndex: actorIdx,
      tipPool: 0,
      voluntaryRaiseLevel: 0,
      rakeEnabled,
    }

    game.dealerSeatNumber = dealerSeatNumber
    game.handState = handState
    return { ok: true }
  }

  processAction(
    tableId: string,
    userId: string,
    action: BettingAction,
    amount?: number,
  ): ActionResult {
    const game = this.games.get(tableId)
    if (!game?.handState) return { error: 'No active hand at this table' }
    const state = game.handState

    if (state.currentActorIndex < 0) return { error: 'No player to act right now' }

    const actor = state.players[state.currentActorIndex]
    if (actor.playerId !== userId) return { error: 'It is not your turn' }
    if (actor.status !== 'active') return { error: 'You are not active in this hand' }

    switch (action) {
      case 'FOLD':
        actor.status = 'folded'
        actor.hasActedThisRound = true
        break

      case 'CHECK':
        if (actor.roundContribution < state.currentBet) {
          return { error: `Cannot check — there is a bet of ${state.currentBet} to call` }
        }
        actor.hasActedThisRound = true
        break

      case 'CALL': {
        if (actor.roundContribution >= state.currentBet) {
          return { error: 'Nothing to call — use CHECK' }
        }
        const needed = state.currentBet - actor.roundContribution
        const paying = Math.min(needed, actor.stack)
        actor.stack -= paying
        actor.roundContribution += paying
        actor.totalContributed += paying
        state.pot += paying
        if (actor.stack === 0) actor.status = 'all-in'
        actor.hasActedThisRound = true
        break
      }

      case 'RAISE': {
        if (amount == null) return { error: 'Raise amount required' }
        if (amount <= state.currentBet) {
          return { error: `Raise must exceed the current bet of ${state.currentBet}` }
        }
        const raiseBy = amount - state.currentBet
        if (raiseBy < state.minRaise) {
          return { error: `Minimum raise increment is ${state.minRaise} (raise to at least ${state.currentBet + state.minRaise})` }
        }
        const needed = amount - actor.roundContribution
        if (needed > actor.stack) {
          return { error: 'Not enough chips — use ALL_IN instead' }
        }
        // Settle tip for the previous voluntary raise level (before this actor's chips change).
        this.settleTipForRound(state)
        actor.stack -= needed
        actor.roundContribution += needed
        actor.totalContributed += needed
        state.pot += needed
        state.minRaise = raiseBy
        state.currentBet = amount
        state.voluntaryRaiseLevel = amount
        if (actor.stack === 0) actor.status = 'all-in'
        actor.hasActedThisRound = true
        // All other active players must act again after a raise.
        for (const p of state.players) {
          if (p.playerId !== actor.playerId && p.status === 'active') {
            p.hasActedThisRound = false
          }
        }
        break
      }

      case 'ALL_IN': {
        const fullContrib = actor.roundContribution + actor.stack

        // Cap to the highest total any non-folded opponent can reach this round.
        // Prevents uncallable chips entering the pot when the big stack shoves.
        const maxOpponentLevel = state.players
          .filter(p => p.playerId !== actor.playerId && p.status !== 'folded')
          .reduce((max, p) => Math.max(max, p.roundContribution + p.stack), 0)

        // Apply cap only when the actor is the deepest stack and the cap would reduce the shove.
        const cappedContrib =
          maxOpponentLevel > actor.roundContribution && maxOpponentLevel < fullContrib
            ? maxOpponentLevel
            : fullContrib

        const actualCommit = cappedContrib - actor.roundContribution

        if (cappedContrib > state.currentBet) {
          this.settleTipForRound(state)
        }

        actor.roundContribution = cappedContrib
        actor.totalContributed += actualCommit
        state.pot += actualCommit
        actor.stack -= actualCommit
        if (actor.stack === 0) actor.status = 'all-in'
        actor.hasActedThisRound = true

        if (cappedContrib > state.currentBet) {
          const raiseBy = cappedContrib - state.currentBet
          if (raiseBy >= state.minRaise) state.minRaise = raiseBy
          state.currentBet = cappedContrib
          state.voluntaryRaiseLevel = cappedContrib
          for (const p of state.players) {
            if (p.playerId !== actor.playerId && p.status === 'active') {
              p.hasActedThisRound = false
            }
          }
        }
        break
      }

      default:
        return { error: 'Unknown action' }
    }

    // Hand over if only one non-folded player remains.
    const standing = state.players.filter(p => p.status !== 'folded')
    if (standing.length === 1) {
      const data = this.buildHandEndedData(state, game.handCount, 'all_folded')
      game.handState = null
      return { ok: true, handEnded: true, data }
    }

    if (this.isBettingRoundComplete(state)) {
      const cont = this.advanceToNextRound(state)
      if (cont === false) {
        const data = this.buildHandEndedData(state, game.handCount, 'showdown')
        game.handState = null
        return { ok: true, handEnded: true, data }
      }
      if (cont === 'runout') {
        // All remaining players are all-in — server will deal remaining streets with delays.
        return { ok: true, runout: true }
      }
    } else {
      this.advanceTurnIndex(state)
    }

    return { ok: true }
  }

  // Deal the next community street during an all-in runout (called by server.ts with delays).
  dealNextRunoutStreet(tableId: string): RunoutStreetResult {
    const game = this.games.get(tableId)
    if (!game?.handState) return { error: 'No active hand' }
    const state = game.handState

    // Settle any tip (usually zero during runout streets).
    this.settleTipForRound(state)

    // Reset round state.
    for (const p of state.players) {
      p.roundContribution = 0
      if (p.status === 'active') p.hasActedThisRound = false
    }
    state.currentBet = 0
    state.minRaise = state.bigBlind
    state.voluntaryRaiseLevel = 0

    if (!this.dealNextStreet(state)) {
      // No more streets — hand ends.
      const data = this.buildHandEndedData(state, game.handCount, 'showdown')
      game.handState = null
      return { ok: true, handEnded: true, data }
    }

    // Nobody acts during a runout — clear the actor so no client is prompted.
    state.currentActorIndex = -1

    return {
      ok: true,
      handEnded: false,
      phase: state.phase,
      communityCards: state.communityCards as Card[],
    }
  }

  private buildHandEndedData(
    state: HandState,
    handNumber: number,
    reason: 'all_folded' | 'showdown',
  ): HandEndedData {
    // Settle any remaining tip before the hand ends.
    this.settleTipForRound(state)
    return {
      reason,
      handNumber,
      startedAt: state.startedAt,
      communityCards: [...state.communityCards],
      pot: state.pot,
      tipAmount: state.tipPool,
      players: state.players.map(p => ({
        playerId: p.playerId,
        username: p.username,
        seatNumber: p.seatNumber,
        stackAtEnd: p.stack,
        totalContributed: p.totalContributed,
        hasFolded: p.status === 'folded',
        holeCards: [p.holeCards[0], p.holeCards[1]],
      })),
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  // Settle the current voluntary raise level: if ≥ 2 players have contributed
  // exactly the raise level, add 3.8% of (level × count) to tipPool. Never
  // accumulates for Sit & Go hands (rakeEnabled false) — their house fee was
  // already taken out of the buy-in, so this stays genuinely 0, not just
  // zeroed out downstream at showdown.
  // Must be called BEFORE the acting player's roundContribution is updated.
  private settleTipForRound(state: HandState): void {
    if (state.voluntaryRaiseLevel <= 0) return
    const level = state.voluntaryRaiseLevel
    if (state.rakeEnabled) {
      const count = state.players.filter(p => p.roundContribution === level).length
      if (count >= 2) {
        state.tipPool += Math.floor(0.038 * level * count)
      }
    }
    state.voluntaryRaiseLevel = 0
  }

  private isBettingRoundComplete(state: HandState): boolean {
    const active = state.players.filter(p => p.status === 'active')
    if (active.length === 0) return true
    return active.every(
      p => p.hasActedThisRound && p.roundContribution >= state.currentBet,
    )
  }

  // Single-step advance: settle tip, reset round, deal ONE next street.
  // Returns:
  //   false    → RIVER was the last street; caller should end the hand.
  //   'runout' → next street dealt but fewer than 2 active players; server auto-deals the rest.
  //   true     → next street dealt and at least 2 active players can bet.
  private advanceToNextRound(state: HandState): boolean | 'runout' {
    // Settle tip for the completed betting round.
    this.settleTipForRound(state)

    // Reset per-round state.
    for (const p of state.players) {
      p.roundContribution = 0
      if (p.status === 'active') p.hasActedThisRound = false
    }
    state.currentBet = 0
    state.minRaise = state.bigBlind
    state.voluntaryRaiseLevel = 0

    if (!this.dealNextStreet(state)) return false  // RIVER is the last street

    this.setFirstPostFlopActor(state)

    // Runout when 0 or 1 active player remains: no meaningful betting is possible.
    // (A single active player has no opponent who can respond to a bet.)
    const activeCnt = state.players.filter(p => p.status === 'active').length
    if (activeCnt < 2) {
      state.currentActorIndex = -1  // nobody should be prompted to act
      return 'runout'
    }
    return true
  }

  // Deals the next community cards. Returns false when RIVER has been played.
  private dealNextStreet(state: HandState): boolean {
    const d = state.deckRemaining
    if (state.phase === 'PRE_FLOP') {
      d.shift() // burn
      state.communityCards.push(d.shift()!, d.shift()!, d.shift()!)
      state.phase = 'FLOP'
      return true
    }
    if (state.phase === 'FLOP') {
      d.shift()
      state.communityCards.push(d.shift()!)
      state.phase = 'TURN'
      return true
    }
    if (state.phase === 'TURN') {
      d.shift()
      state.communityCards.push(d.shift()!)
      state.phase = 'RIVER'
      return true
    }
    return false // RIVER is the last street
  }

  // Post-flop: first active player left of the dealer (clockwise).
  private setFirstPostFlopActor(state: HandState): void {
    const n = state.players.length
    const dIdx = state.players.findIndex(p => p.seatNumber === state.dealerSeatNumber)
    const start = (dIdx + 1) % n
    let idx = start
    do {
      if (state.players[idx].status === 'active') {
        state.currentActorIndex = idx
        return
      }
      idx = (idx + 1) % n
    } while (idx !== start)
    state.currentActorIndex = -1
  }

  // Moves currentActorIndex to the next active player (skipping folded / all-in).
  private advanceTurnIndex(state: HandState): void {
    const n = state.players.length
    const start = (state.currentActorIndex + 1) % n
    let idx = start
    do {
      if (state.players[idx].status === 'active') {
        state.currentActorIndex = idx
        return
      }
      idx = (idx + 1) % n
    } while (idx !== start)
    state.currentActorIndex = -1
  }

  private nextDealerIndex(currentDealerSeat: number, seats: number[]): number {
    if (currentDealerSeat === 0) return 0
    const idx = seats.indexOf(currentDealerSeat)
    if (idx === -1) return 0
    return (idx + 1) % seats.length
  }
}
