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
  | { ok: true; handEnded?: false }
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
  ): Promise<{ ok: true } | { error: string }> {
    if (seatedPlayers.length < 2) {
      return { error: 'Need at least 2 seated players to start a hand' }
    }

    // Sort by seat number for a consistent, deterministic player order.
    const sorted = [...seatedPlayers].sort((a, b) => a.seatNumber - b.seatNumber)
    const n = sorted.length

    // Load stacks from the wallets table.
    const { data: walletRows, error: walletErr } = await supabase
      .from('wallets')
      .select('user_id, chips')
      .in('user_id', sorted.map(p => p.playerId))

    if (walletErr) return { error: 'Failed to load player stacks' }

    const stackMap = new Map<string, number>()
    for (const w of (walletRows as Array<{ user_id: string; chips: number }> | null) ?? []) {
      stackMap.set(w.user_id, w.chips)
    }

    for (const p of sorted) {
      if ((stackMap.get(p.playerId) ?? 0) === 0) {
        return { error: `${p.username} has no chips` }
      }
    }

    const game = this.getOrCreate(tableId)

    // Rotate the dealer button.
    const seatNums = sorted.map(p => p.seatNumber)
    const dealerIdx = this.nextDealerIndex(game.dealerSeatNumber, seatNums)
    const dealerSeatNumber = sorted[dealerIdx].seatNumber

    // Determine SB, BB and first-to-act positions.
    let sbIdx: number
    let bbIdx: number
    let firstActorIdx: number
    if (n === 2) {
      // Heads-up: dealer = SB, SB acts first pre-flop.
      sbIdx = dealerIdx
      bbIdx = (dealerIdx + 1) % n
      firstActorIdx = sbIdx
    } else {
      sbIdx = (dealerIdx + 1) % n
      bbIdx = (dealerIdx + 2) % n
      firstActorIdx = (dealerIdx + 3) % n
    }

    // Create and shuffle a fresh deck.
    const deckCopy = [...shuffle(createDeck())]

    // Deal one card at a time starting from the SB position.
    const firstCards: Card[] = new Array(n)
    const secondCards: Card[] = new Array(n)
    for (let i = 0; i < n; i++) firstCards[(sbIdx + i) % n] = deckCopy.shift()!
    for (let i = 0; i < n; i++) secondCards[(sbIdx + i) % n] = deckCopy.shift()!

    const players: PlayerHandState[] = sorted.map((p, i) => ({
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
    for (let i = 0; i < n; i++) {
      if (players[actorIdx].status === 'active') break
      actorIdx = (actorIdx + 1) % n
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
      smallBlindSeatNumber: sorted[sbIdx].seatNumber,
      bigBlindSeatNumber: sorted[bbIdx].seatNumber,
      pot: sbAmt + bbAmt,
      currentBet: bigBlind,
      minRaise: bigBlind,
      currentActorIndex: actorIdx,
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
        actor.stack -= needed
        actor.roundContribution += needed
        actor.totalContributed += needed
        state.pot += needed
        state.minRaise = raiseBy
        state.currentBet = amount
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
        const allIn = actor.stack
        actor.roundContribution += allIn
        actor.totalContributed += allIn
        state.pot += allIn
        actor.stack = 0
        actor.status = 'all-in'
        actor.hasActedThisRound = true
        // If the all-in constitutes a full raise, update currentBet and reset others.
        if (actor.roundContribution > state.currentBet) {
          const raiseBy = actor.roundContribution - state.currentBet
          if (raiseBy >= state.minRaise) state.minRaise = raiseBy
          state.currentBet = actor.roundContribution
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
      if (!cont) {
        const data = this.buildHandEndedData(state, game.handCount, 'showdown')
        game.handState = null
        return { ok: true, handEnded: true, data }
      }
    } else {
      this.advanceTurnIndex(state)
    }

    return { ok: true }
  }

  private buildHandEndedData(
    state: HandState,
    handNumber: number,
    reason: 'all_folded' | 'showdown',
  ): HandEndedData {
    return {
      reason,
      handNumber,
      startedAt: state.startedAt,
      communityCards: [...state.communityCards],
      pot: state.pot,
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

  private isBettingRoundComplete(state: HandState): boolean {
    const active = state.players.filter(p => p.status === 'active')
    if (active.length === 0) return true
    return active.every(
      p => p.hasActedThisRound && p.roundContribution >= state.currentBet,
    )
  }

  // Advances through streets (looping when no active players remain, e.g. all-in runout).
  // Returns false when the RIVER betting is complete → hand should end.
  private advanceToNextRound(state: HandState): boolean {
    while (this.isBettingRoundComplete(state)) {
      for (const p of state.players) {
        p.roundContribution = 0
        if (p.status === 'active') p.hasActedThisRound = false
      }
      state.currentBet = 0
      state.minRaise = state.bigBlind

      if (!this.dealNextStreet(state)) return false

      this.setFirstPostFlopActor(state)
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
