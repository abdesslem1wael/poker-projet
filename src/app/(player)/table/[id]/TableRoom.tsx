'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  TableStatePayload,
  Card,
  BettingAction,
  ShowdownPayload,
  PublicHandState,
} from '@/lib/socket/types'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'
import { getAvatar } from '@/lib/avatars'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Props = {
  initialState: TableStatePayload
  currentUserId: string
  myStatus: 'seated' | 'spectating'
  mySeatNumber: number | null
  isAdmin?: boolean
}

type SessionInfo = {
  secondsRemaining: number
  isExpired: boolean
  tableName: string
  syncedAt: number  // epoch ms when we last received a session_update
}

type LastAction = { action: BettingAction; amount?: number }
type PreAction  = 'auto-check' | 'check-fold' | 'auto-fold'

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUIT_SYM: Record<string, string> = {
  clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠',
}
const RED_SUITS = new Set(['diamonds', 'hearts'])

function formatAction(la: LastAction): string {
  switch (la.action) {
    case 'FOLD':   return 'Folded'
    case 'CHECK':  return 'Checked'
    case 'CALL':   return `Called ${la.amount?.toLocaleString() ?? ''}`
    case 'RAISE':  return `Raised → ${la.amount?.toLocaleString() ?? ''}`
    case 'ALL_IN': return 'All In!'
    default:       return la.action
  }
}

function actionLabelColor(action: BettingAction): string {
  switch (action) {
    case 'FOLD':   return '#ef4444'
    case 'CHECK':  return '#10b981'
    case 'CALL':   return '#22c55e'
    case 'RAISE':  return '#3b82f6'
    case 'ALL_IN': return '#a855f7'
    default:       return '#94a3b8'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seat position math (seats placed on oval around the table)
// Seat 1 = bottom-centre; seats go clockwise.
// Anchor rotates so the current player's actual seat becomes visual seat 1.
// ─────────────────────────────────────────────────────────────────────────────

function toVisual(actual: number, anchor: number, max: number): number {
  return ((actual - anchor + max) % max) + 1
}

function seatPos(vs: number, max: number): React.CSSProperties {
  // +angle = clockwise (vs=2 is to the left of vs=1 when hero is at bottom)
  const rad = ((180 + (vs - 1) * (360 / max)) * Math.PI) / 180
  const yScale = vs === 1 ? 45 : 42
  return {
    position: 'absolute',
    left: `${(50 + 46 * Math.sin(rad)).toFixed(2)}%`,
    top:  `${(50 - yScale * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
    zIndex: vs === 1 ? 20 : 10,
  }
}

function chipPos(vs: number, max: number): React.CSSProperties {
  const rad = ((180 + (vs - 1) * (360 / max)) * Math.PI) / 180
  return {
    position: 'absolute',
    left: `${(50 + 27 * Math.sin(rad)).toFixed(2)}%`,
    top:  `${(50 - 24 * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
  }
}

// Deterministic avatar fallback so nobody ever sees a "?" on the table.
function fallbackAvatarId(username: string | null): number {
  if (!username) return 1
  let h = 0
  for (const c of username) h = ((h * 31) + c.charCodeAt(0)) & 0x7fffffff
  return (h % 20) + 1
}

// ─────────────────────────────────────────────────────────────────────────────
// Pip positions for number cards
// ─────────────────────────────────────────────────────────────────────────────

const PIP_POSITIONS: Record<string, [number, number][]> = {
  '2':  [[50,20],[50,80]],
  '3':  [[50,18],[50,50],[50,82]],
  '4':  [[30,22],[70,22],[30,78],[70,78]],
  '5':  [[30,22],[70,22],[50,50],[30,78],[70,78]],
  '6':  [[30,20],[70,20],[30,50],[70,50],[30,80],[70,80]],
  '7':  [[30,20],[70,20],[50,35],[30,50],[70,50],[30,80],[70,80]],
  '8':  [[30,20],[70,20],[50,33],[30,50],[70,50],[50,67],[30,80],[70,80]],
  '9':  [[30,18],[70,18],[30,38],[70,38],[50,50],[30,62],[70,62],[30,82],[70,82]],
  '10': [[30,18],[70,18],[50,30],[30,40],[70,40],[50,60],[30,60],[70,60],[30,82],[70,82]],
}

// ─────────────────────────────────────────────────────────────────────────────
// PlayingCard
// ─────────────────────────────────────────────────────────────────────────────

type CardSize = 'xs' | 'sm' | 'md' | 'community' | 'hand'

const CARD_DIMS: Record<CardSize, {
  w: number; h: number; cornerRank: number; cornerSuit: number;
  centerFont: number; pipFont: number; r: number; pad: number
}> = {
  xs:        { w: 28,  h: 40,  cornerRank: 9,  cornerSuit: 7,  centerFont: 18, pipFont: 7,  r: 3, pad: 2   },
  sm:        { w: 36,  h: 52,  cornerRank: 10, cornerSuit: 8,  centerFont: 22, pipFont: 9,  r: 4, pad: 2.5 },
  md:        { w: 46,  h: 64,  cornerRank: 12, cornerSuit: 10, centerFont: 28, pipFont: 11, r: 5, pad: 3   },
  community: { w: 54,  h: 76,  cornerRank: 13, cornerSuit: 11, centerFont: 34, pipFont: 13, r: 6, pad: 3.5 },
  hand:      { w: 64,  h: 90,  cornerRank: 15, cornerSuit: 12, centerFont: 40, pipFont: 15, r: 7, pad: 4   },
}

function PlayingCard({ c, size }: { c: Card; size: CardSize }) {
  const red = RED_SUITS.has(c.suit)
  const sym = SUIT_SYM[c.suit]
  const color = red ? '#dc2626' : '#111827'
  const d = CARD_DIMS[size]
  const isFace = ['J', 'Q', 'K', 'A'].includes(c.rank)
  const pips = PIP_POSITIONS[c.rank]

  return (
    <div
      style={{
        width: d.w, height: d.h, position: 'relative', flexShrink: 0,
        background: 'white',
        borderRadius: d.r,
        border: `1px solid ${red ? '#fca5a5' : '#d1d5db'}`,
        boxShadow: '0 2px 6px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.1)',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute', top: d.pad, left: d.pad + 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        lineHeight: 1, color, fontFamily: 'Georgia, serif',
      }}>
        <span style={{ fontSize: d.cornerRank, fontWeight: 700, letterSpacing: '-0.5px' }}>{c.rank}</span>
        <span style={{ fontSize: d.cornerSuit, marginTop: -1 }}>{sym}</span>
      </div>
      <div style={{
        position: 'absolute', bottom: d.pad, right: d.pad + 1,
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        lineHeight: 1, color, transform: 'rotate(180deg)', fontFamily: 'Georgia, serif',
      }}>
        <span style={{ fontSize: d.cornerRank, fontWeight: 700, letterSpacing: '-0.5px' }}>{c.rank}</span>
        <span style={{ fontSize: d.cornerSuit, marginTop: -1 }}>{sym}</span>
      </div>
      {isFace ? (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color, lineHeight: 1,
        }}>
          {c.rank === 'A' ? (
            <span style={{ fontSize: d.centerFont, fontFamily: 'Georgia, serif' }}>{sym}</span>
          ) : (
            <>
              <span style={{ fontSize: d.centerFont * 0.75, fontFamily: 'Georgia, serif', fontWeight: 700, color, lineHeight: 1 }}>{c.rank}</span>
              <span style={{ fontSize: d.centerFont * 0.55, marginTop: 1 }}>{sym}</span>
            </>
          )}
        </div>
      ) : pips ? (
        <div style={{ position: 'absolute', inset: 0 }}>
          {pips.map(([px, py], i) => {
            const padFrac = 0.18
            const usableW = d.w * (1 - 2 * padFrac)
            const usableH = d.h * (1 - 2 * padFrac)
            const ox = d.w * padFrac
            const oy = d.h * padFrac
            const x = ox + (px / 100) * usableW
            const y = oy + (py / 100) * usableH
            return (
              <span key={i} style={{
                position: 'absolute', left: x, top: y,
                transform: `translate(-50%,-50%)${py > 55 ? ' rotate(180deg)' : ''}`,
                fontSize: d.pipFont, color, lineHeight: 1, display: 'block',
              }}>{sym}</span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CardBack
// ─────────────────────────────────────────────────────────────────────────────

function CardBack({ size }: { size: CardSize }) {
  const d = CARD_DIMS[size]
  return (
    <div style={{
      width: d.w, height: d.h, flexShrink: 0,
      borderRadius: d.r,
      border: '1px solid rgba(201,168,76,0.22)',
      boxShadow: '0 3px 10px rgba(0,0,0,0.55)',
      overflow: 'hidden',
      background: '#1a2a4a',
      position: 'relative',
    }}>
      <span style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        fontSize: d.w * 0.52, color: 'rgba(201,168,76,0.4)',
        lineHeight: 1, userSelect: 'none',
      }}>♠</span>
      <div style={{
        position: 'absolute', inset: 3,
        borderRadius: d.r - 2,
        border: '1px solid rgba(201,168,76,0.15)',
        background: 'repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(201,168,76,0.04) 3px,rgba(201,168,76,0.04) 6px)',
      }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TimerRing
// ─────────────────────────────────────────────────────────────────────────────

const TIMER_TOTAL = 60

function TimerRing({ t }: { t: number }) {
  const r = 24
  const circ = 2 * Math.PI * r
  const dash = Math.max(0, (t / TIMER_TOTAL) * circ)
  const low = t <= 15
  return (
    <svg viewBox="0 0 52 52" fill="none" className="absolute inset-0 h-full w-full"
      style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="26" cy="26" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
      <circle cx="26" cy="26" r={r}
        stroke={low ? '#ef4444' : '#eab308'}
        strokeWidth="2.5"
        strokeDasharray={`${dash.toFixed(2)} ${circ.toFixed(2)}`}
        strokeLinecap="round"
      />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ChipStack
// ─────────────────────────────────────────────────────────────────────────────

function chipColor(amount: number): string[] {
  if (amount >= 10000) return ['#7c3aed', '#8b5cf6', '#a78bfa']
  if (amount >= 1000)  return ['#dc2626', '#ef4444', '#f87171']
  if (amount >= 500)   return ['#1d4ed8', '#2563eb', '#60a5fa']
  if (amount >= 100)   return ['#059669', '#10b981', '#34d399']
  return ['#92400e', '#d97706', '#fbbf24']
}

function ChipStack({ amount }: { amount: number }) {
  const colors = chipColor(amount)
  const layers = Math.min(5, Math.max(2, Math.floor(Math.log10(amount + 1))))
  return (
    <div className="flex flex-col items-center">
      <div style={{ position: 'relative', width: 20, height: 20 + layers * 2 }}>
        {Array.from({ length: layers }).map((_, i) => (
          <span key={i} style={{
            position: 'absolute', bottom: i * 3, left: 0,
            width: 20, height: 20, borderRadius: '50%',
            background: `radial-gradient(circle at 35% 35%, ${colors[Math.min(i, colors.length - 1)]}, ${colors[0]})`,
            border: '1.5px solid rgba(255,255,255,0.25)',
            boxShadow: i === 0 ? '0 2px 4px rgba(0,0,0,0.5)' : 'none',
          }} />
        ))}
      </div>
      <span style={{
        marginTop: 2,
        background: 'rgba(0,0,0,0.8)',
        color: '#fbbf24', fontSize: 9, fontWeight: 700,
        padding: '1px 4px', borderRadius: 3, letterSpacing: '-0.3px', whiteSpace: 'nowrap',
      }}>
        {amount >= 1000 ? `${(amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 1)}k` : amount}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DealerButton
// ─────────────────────────────────────────────────────────────────────────────

function DealerButton() {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: '50%',
      background: 'radial-gradient(circle at 35% 35%, #fef9c3, #ca8a04)',
      border: '1.5px solid #92400e',
      color: '#1a0a00', fontSize: 8, fontWeight: 900,
      boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
      flexShrink: 0,
    }}>D</span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ShuffleAnimation
// ─────────────────────────────────────────────────────────────────────────────

function ShuffleAnimation() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 80 }}>
      <style>{`
        @keyframes shuffle1 { 0%,100%{transform:rotate(-8deg) translateY(0)} 50%{transform:rotate(8deg) translateY(-6px)} }
        @keyframes shuffle2 { 0%,100%{transform:rotate(4deg) translateY(-3px)} 50%{transform:rotate(-4deg) translateY(4px)} }
        @keyframes shuffle3 { 0%,100%{transform:rotate(-3deg) translateY(0)} 50%{transform:rotate(6deg) translateY(-8px)} }
        @keyframes shuffle4 { 0%,100%{transform:rotate(6deg) translateY(-5px)} 50%{transform:rotate(-6deg) translateY(2px)} }
        @keyframes shuffle5 { 0%,100%{transform:rotate(-5deg) translateY(2px)} 50%{transform:rotate(3deg) translateY(-4px)} }
      `}</style>
      {[1,2,3,4,5].map(i => (
        <div key={i} style={{
          width: 30, height: 42, borderRadius: 4,
          background: 'repeating-linear-gradient(45deg, #1e3a8a 0px, #1e3a8a 3px, #1d4ed8 3px, #1d4ed8 8px)',
          border: '1px solid #1e3a8a', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          animation: `shuffle${i} ${0.4 + i * 0.07}s ease-in-out infinite`,
          animationDelay: `${i * 0.06}s`,
        }} />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Showdown helpers
// ─────────────────────────────────────────────────────────────────────────────

function isInBestHand(card: Card, bestHand: [Card, Card, Card, Card, Card] | null | undefined): boolean {
  if (!bestHand) return false
  return bestHand.some(c => c.rank === card.rank && c.suit === card.suit)
}

function WinningCard({ c, size, inBest }: { c: Card; size: CardSize; inBest: boolean }) {
  return (
    <div style={{
      borderRadius: CARD_DIMS[size].r + 2,
      boxShadow: inBest ? '0 0 0 2px #eab308, 0 0 10px rgba(234,179,8,0.55)' : 'none',
      opacity: inBest ? 1 : 0.32, flexShrink: 0, lineHeight: 0,
    }}>
      <PlayingCard c={c} size={size} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ShowdownBanner
// ─────────────────────────────────────────────────────────────────────────────

function ShowdownBanner({
  showdown, currentUserId, myHoleCards, onShow, revealedCards,
}: {
  showdown: ShowdownPayload
  currentUserId: string
  myHoleCards: [Card, Card] | null
  onShow: (cards: [Card, Card]) => void
  revealedCards: Record<string, [Card, Card]>
}) {
  const [revealFolded, setRevealFolded] = useState(false)
  const [muckedFolded, setMuckedFolded] = useState(false)

  const isAllFolded   = showdown.reason === 'all_folded'
  const primaryPot    = showdown.pots[0]
  const winnerIds     = new Set(primaryPot?.winners ?? [])
  const winnerPlayers = showdown.players.filter(p => winnerIds.has(p.playerId))
  const primaryWinner = winnerPlayers[0]
  const bestHand      = primaryWinner?.bestHand ?? null
  const hasBoard      = showdown.communityCards.length > 0
  const hasCards      = !isAllFolded && (hasBoard || primaryWinner?.holeCards != null)
  const others        = showdown.players.filter(p => !winnerIds.has(p.playerId))
  const winnerLabel   = winnerPlayers.map(w => w.username).join(' & ')
  const winnerNet     = primaryPot?.amount ?? 0
  const sidePots      = showdown.pots.slice(1)

  return (
    <div style={{
      pointerEvents: 'auto',
      background: 'rgba(4, 10, 22, 0.93)',
      border: '1px solid rgba(234,179,8,0.38)',
      borderRadius: 14, padding: '10px 14px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
      maxWidth: 400,
      boxShadow: '0 0 0 1px rgba(234,179,8,0.1), 0 8px 40px rgba(0,0,0,0.75)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 15 }}>🏆</span>
        <span style={{ color: '#fde68a', fontWeight: 800, fontSize: 14 }}>{winnerLabel}</span>
        <span style={{ color: '#4ade80', fontWeight: 700, fontSize: 13, background: 'rgba(74,222,128,0.1)', borderRadius: 6, padding: '1px 6px' }}>
          +{winnerNet.toLocaleString()}
        </span>
      </div>

      {primaryPot && (
        <span style={{
          background: isAllFolded ? '#1c2333' : '#162038',
          color: isAllFolded ? '#6b7280' : '#93c5fd',
          fontSize: 10, fontWeight: 800, padding: '2px 12px', borderRadius: 20,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          border: isAllFolded ? '1px solid #374151' : '1px solid rgba(147,197,253,0.2)',
        }}>
          {primaryPot.winnerHandName}
        </span>
      )}

      {hasCards && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 5 }}>
          {hasBoard && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: '#475569', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 32, flexShrink: 0 }}>Board</span>
              <div style={{ display: 'flex', gap: 3 }}>
                {showdown.communityCards.map((c, i) => (
                  <WinningCard key={i} c={c} size="sm" inBest={isInBestHand(c, bestHand)} />
                ))}
              </div>
            </div>
          )}
          {primaryWinner?.holeCards && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ color: '#475569', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 32, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={primaryWinner.username}>
                {primaryWinner.username.slice(0, 4)}
              </span>
              <div style={{ display: 'flex', gap: 3 }}>
                {primaryWinner.holeCards.map((c, i) => (
                  <WinningCard key={i} c={c} size="sm" inBest={isInBestHand(c, bestHand)} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {sidePots.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
          {sidePots.map((pot, i) => {
            const potWinners = showdown.players.filter(p => pot.winners.includes(p.playerId))
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
                <span style={{ color: '#475569' }}>Side pot</span>
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>{pot.amount.toLocaleString()}</span>
                <span style={{ color: '#86efac' }}>→ {potWinners.map(w => w.username).join(' & ')}</span>
                {pot.winnerHandName !== 'Last Standing' && (
                  <span style={{ color: '#475569' }}>({pot.winnerHandName})</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {others.length > 0 && (
        <>
          <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.07)' }} />
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {others.map(p => {
              const isCurrentPlayer = p.playerId === currentUserId
              const canReveal = isCurrentPlayer && p.hasFolded && myHoleCards != null
              const showButtons = canReveal && !revealFolded && !muckedFolded
              // Cards to display: for current player use local state; for others use server-broadcast
              const cardsToShow: [Card, Card] | null =
                revealedCards[p.playerId] ?? (isCurrentPlayer && revealFolded ? myHoleCards : null)

              return (
                <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <span style={{ color: isCurrentPlayer ? '#93c5fd' : '#94a3b8', fontWeight: 600, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 64, flexShrink: 0 }}>
                    {isCurrentPlayer ? 'You' : p.username}
                  </span>
                  {p.hasFolded && cardsToShow ? (
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      <PlayingCard c={cardsToShow[0]} size="xs" />
                      <PlayingCard c={cardsToShow[1]} size="xs" />
                    </div>
                  ) : p.hasFolded ? (
                    <span style={{ color: '#4b5563', fontSize: 10, fontStyle: 'italic', flexShrink: 0 }}>folded</span>
                  ) : p.holeCards ? (
                    <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                      <PlayingCard c={p.holeCards[0]} size="xs" />
                      <PlayingCard c={p.holeCards[1]} size="xs" />
                    </div>
                  ) : null}
                  {!p.hasFolded && p.handName && (
                    <span style={{ color: '#64748b', fontSize: 10, flexShrink: 0 }}>{p.handName}</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{ color: p.netChipChange > 0 ? '#4ade80' : '#f87171', fontWeight: 700, fontSize: 11, flexShrink: 0 }}>
                    {p.netChipChange > 0 ? '+' : ''}{p.netChipChange.toLocaleString()}
                  </span>
                  {showButtons && (
                    <div style={{ display: 'flex', gap: 3, marginLeft: 2, flexShrink: 0 }}>
                      <button onClick={() => { setRevealFolded(true); if (myHoleCards) onShow(myHoleCards) }}
                        style={{ background: 'rgba(30,58,138,0.45)', border: '1px solid rgba(59,130,246,0.4)', borderRadius: 4, padding: '2px 6px', color: '#93c5fd', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(30,58,138,0.75)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(30,58,138,0.45)')}
                      >Show</button>
                      <button onClick={() => setMuckedFolded(true)} style={{ background: 'transparent', border: '1px solid rgba(71,85,105,0.4)', borderRadius: 4, padding: '2px 6px', color: '#6b7280', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(100,116,139,0.7)')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(71,85,105,0.4)')}
                      >Muck</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DealerTipModal
// ─────────────────────────────────────────────────────────────────────────────

function DealerTipModal({ winAmount, onTip, onSkip }: {
  winAmount: number
  onTip: (amount: number) => void
  onSkip: () => void
}) {
  const [custom, setCustom] = useState('')
  const pcts = [2, 4, 6, 8]

  return (
    <div style={{
      position: 'fixed', bottom: 130, right: 14, zIndex: 900,
      background: 'linear-gradient(145deg, #0e1c30, #0a1520)',
      border: '1px solid rgba(201,168,76,0.35)',
      borderRadius: 12, padding: '12px 14px', width: 220,
      boxShadow: '0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px rgba(201,168,76,0.08)',
      pointerEvents: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ color: '#fbbf24', fontSize: 13, fontWeight: 700 }}>Tip the dealer?</div>
          <div style={{ color: '#475569', fontSize: 10, marginTop: 1 }}>Won {winAmount.toLocaleString()}</div>
        </div>
        <button onClick={onSkip} style={{ background: 'transparent', border: 'none', color: '#475569', fontSize: 16, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
        {pcts.map(pct => {
          const amt = Math.floor(winAmount * pct / 100)
          return (
            <button key={pct} onClick={() => onTip(amt)}
              style={{ background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.18)', borderRadius: 8, padding: '7px 4px', cursor: 'pointer', color: 'white', textAlign: 'center' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.07)')}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fbbf24' }}>{pct}%</div>
              <div style={{ fontSize: 9, color: '#64748b', marginTop: 1 }}>{amt.toLocaleString()}</div>
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 5 }}>
        <input type="number" placeholder="Custom" value={custom} onChange={e => setCustom(e.target.value)}
          style={{ flex: 1, background: '#0a1520', border: '1px solid #1e3a58', borderRadius: 6, padding: '6px 8px', color: 'white', fontSize: 11, outline: 'none', minWidth: 0 }}
          onFocus={e => (e.currentTarget.style.borderColor = '#c9a84c')}
          onBlur={e => (e.currentTarget.style.borderColor = '#1e3a58')}
        />
        <button onClick={() => { const n = parseInt(custom, 10); if (n > 0) onTip(n) }}
          disabled={!custom || parseInt(custom, 10) <= 0}
          style={{ background: '#1d4ed8', border: 'none', borderRadius: 6, padding: '6px 10px', color: 'white', fontWeight: 700, cursor: 'pointer', fontSize: 11, opacity: !custom || parseInt(custom, 10) <= 0 ? 0.4 : 1, whiteSpace: 'nowrap' }}
        >Tip</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

function formatSessionTime(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function TableRoom({ initialState, currentUserId, myStatus, mySeatNumber, isAdmin }: Props) {
  const router = useRouter()

  const [state, setState]                = useState<TableStatePayload>(initialState)
  const [leaving, setLeaving]            = useState(false)
  const [connected, setConnected]        = useState(false)
  const [myHoleCards, setMyHoleCards]    = useState<[Card, Card] | null>(null)
  const [raiseAmount, setRaiseAmount]    = useState(0)
  const [showdownResult, setShowdownResult] = useState<ShowdownPayload | null>(null)
  const [turnTimerInfo, setTurnTimerInfo]   = useState<{ playerId: string; endsAt: number } | null>(null)
  const [timeLeft, setTimeLeft]          = useState(0)
  const [nextHandIn, setNextHandIn]      = useState<number | null>(null)
  const [lastActions, setLastActions]    = useState<Record<string, LastAction>>({})
  const [showTipModal, setShowTipModal]  = useState(false)
  const [tipSent, setTipSent]            = useState(false)
  const [preAction, setPreAction]        = useState<PreAction | null>(null)
  const [socketError, setSocketError]    = useState<string | null>(null)
  const [prevHandResult, setPrevHandResult] = useState<ShowdownPayload | null>(null)
  const [showPrevHand, setShowPrevHand]  = useState(false)
  const [revealedCards, setRevealedCards] = useState<Record<string, [Card, Card]>>({})
  const [runoutRevealedCards, setRunoutRevealedCards] = useState<Record<string, [Card, Card]>>({})
  const [sessionInfo, setSessionInfo]    = useState<SessionInfo | null>(null)
  const [sessionDisplay, setSessionDisplay] = useState<number>(0)
  const [kickedMsg, setKickedMsg]        = useState<string | null>(null)

  const nextHandTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const socketRef          = useRef<AppSocket | null>(null)
  const prevShowdownRef    = useRef<ShowdownPayload | null>(null)
  const sessionRef         = useRef<SessionInfo | null>(null)

  // ── Derived values ──────────────────────────────────────────────────────────
  const hand: PublicHandState | null = state.handState
  const max    = state.maxPlayers
  const anchor = mySeatNumber ?? 1

  const isMyTurn   = hand?.currentTurnPlayerId === currentUserId
  const myHP       = hand?.players.find(p => p.playerId === currentUserId)
  const callAmt    = isMyTurn ? Math.max(0, (hand?.currentBet ?? 0) - (myHP?.roundContribution ?? 0)) : 0
  const canCheck   = isMyTurn && callAmt === 0
  const minRaiseTo = (hand?.currentBet ?? 0) + (hand?.minRaise ?? 0)
  const myStack    = myHP?.stack ?? 0
  const myMaxBet   = myStack + (myHP?.roundContribution ?? 0)
  const seatedCnt  = state.seats.filter(s => s.playerId !== null).length
  const sessionActive  = sessionInfo != null && !sessionInfo.isExpired
  const sessionExpired = sessionInfo != null && sessionInfo.isExpired
  const canLeave   = !sessionActive || isAdmin
  const canStart   = myStatus === 'seated' && !hand && seatedCnt >= 2 && nextHandIn === null && !sessionExpired

  // Can I afford to call? If not, only all-in or fold is possible.
  const mustGoAllIn = !canCheck && callAmt > myStack
  // Are there other active (non-folded, non-all-in) players who could respond to a raise?
  const otherActivePlayers = hand?.players.filter(
    p => p.playerId !== currentUserId && p.playerPhase === 'active',
  ) ?? []
  const canRaise = !mustGoAllIn && otherActivePlayers.length > 0 && myStack > callAmt

  const myShowdownResult = showdownResult?.players.find(p => p.playerId === currentUserId)
  const _iWon = myShowdownResult != null && myShowdownResult.netChipChange > 0

  // SB/BB visible only in PRE_FLOP
  const showBlindLabels = hand?.phase === 'PRE_FLOP'

  // Reset raise input when actor changes
  const prevActorRef = useRef<string | null>(null)
  useEffect(() => {
    if (hand?.currentTurnPlayerId !== prevActorRef.current) {
      prevActorRef.current = hand?.currentTurnPlayerId ?? null
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (hand) setRaiseAmount(minRaiseTo)
    }
  }, [hand?.currentTurnPlayerId, minRaiseTo, hand])

  // Turn-timer countdown
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!turnTimerInfo) { setTimeLeft(0); return }
    const tick = () => setTimeLeft(Math.max(0, Math.ceil((turnTimerInfo.endsAt - Date.now()) / 1000)))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [turnTimerInfo])

  // Session local countdown (interpolates between server syncs)
  useEffect(() => {
    if (!sessionInfo) return
    const tick = () => {
      const elapsed = Math.floor((Date.now() - sessionInfo.syncedAt) / 1000)
      setSessionDisplay(Math.max(0, sessionInfo.secondsRemaining - elapsed))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [sessionInfo])

  // ── Pre-action auto-fire ────────────────────────────────────────────────────
  // When our turn starts and a pre-action is queued, execute it immediately.
  useEffect(() => {
    if (!isMyTurn || !preAction || myHP?.playerPhase !== 'active') return

    const fire = preAction

    // Auto-check with an outstanding bet: do nothing, just clear and show normal actions.
    if (fire === 'auto-check' && callAmt > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreAction(null)
      return
    }

    setPreAction(null)

    if (fire === 'auto-check') {
      sendAction('CHECK')
    } else if (fire === 'check-fold') {
      sendAction(callAmt === 0 ? 'CHECK' : 'FOLD')
    } else if (fire === 'auto-fold') {
      sendAction('FOLD')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMyTurn, preAction, myHP?.playerPhase, callAmt])

  // ── Socket setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return
      socketRef.current = socket
      setConnected(socket.connected)

      const onConnect = () => {
        if (!active) return
        setConnected(true)
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', { tableId: initialState.tableId })
      }
      const onDisconnect = () => { if (active) setConnected(false) }
      const onSocketError = (p: { message: string }) => { if (active) setSocketError(p.message) }

      const onTableState = (p: TableStatePayload) => {
        if (!active || p.tableId !== initialState.tableId) return
        setState(p)
        if (!p.handState) setTurnTimerInfo(null)
      }

      const onDealCards = (p: { tableId: string; holeCards: [Card, Card] }) => {
        if (!active || p.tableId !== initialState.tableId) return
        // Save previous showdown before clearing
        if (prevShowdownRef.current) setPrevHandResult(prevShowdownRef.current)
        prevShowdownRef.current = null
        setMyHoleCards(p.holeCards)
        setShowdownResult(null)
        setRevealedCards({})
        setRunoutRevealedCards({})
        setShowPrevHand(false)
        setTurnTimerInfo(null)
        setLastActions({})
        setShowTipModal(false)
        setTipSent(false)
        setPreAction(null)
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
        setNextHandIn(null)
      }

      const onShowdownResult = (p: ShowdownPayload) => {
        if (!active || p.tableId !== initialState.tableId) return
        prevShowdownRef.current = p
        setShowdownResult(p)
        setRunoutRevealedCards({})
        setTurnTimerInfo(null)
        setPreAction(null)
        const me = p.players.find(pl => pl.playerId === currentUserId)
        if (me && me.netChipChange > 0) {
          setTimeout(() => { if (active) setShowTipModal(true) }, 1200)
        }
      }

      const onRunoutCardsRevealed = (p: { tableId: string; players: Array<{ playerId: string; cards: [Card, Card] }> }) => {
        if (!active || p.tableId !== initialState.tableId) return
        const map: Record<string, [Card, Card]> = {}
        for (const player of p.players) map[player.playerId] = player.cards
        setRunoutRevealedCards(map)
      }

      const onHandRevealed = (p: { tableId: string; playerId: string; cards: [Card, Card] }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setRevealedCards(prev => ({ ...prev, [p.playerId]: p.cards }))
      }

      const onActionResult = (p: { tableId: string; playerId: string; action: BettingAction; amount: number }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setTurnTimerInfo(null)
        setLastActions(prev => ({
          ...prev,
          [p.playerId]: { action: p.action, amount: p.amount > 0 ? p.amount : undefined },
        }))
      }

      const onTurnTimerStart = (p: { tableId: string; playerId: string; seconds: number }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setTurnTimerInfo({ playerId: p.playerId, endsAt: Date.now() + p.seconds * 1000 })
      }

      const onNextHandCountdown = (p: { tableId: string; seconds: number }) => {
        if (!active || p.tableId !== initialState.tableId) return
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
        setNextHandIn(p.seconds)
        const id = setInterval(() => {
          setNextHandIn(prev => {
            if (prev === null || prev <= 1) { clearInterval(id); nextHandTimerRef.current = null; return null }
            return prev - 1
          })
        }, 1000)
        nextHandTimerRef.current = id
      }

      const onSessionUpdate = (p: { tableId: string; tableName: string; secondsRemaining: number; isExpired: boolean }) => {
        if (!active || p.tableId !== initialState.tableId) return
        const info: SessionInfo = { ...p, syncedAt: Date.now() }
        sessionRef.current = info
        setSessionInfo(info)
      }

      const onKickedFromTable = (p: { tableId: string }) => {
        if (!active || p.tableId !== initialState.tableId) return
        setKickedMsg('You have been removed from this table by the admin.')
        setTimeout(() => { if (active) router.push('/lobby') }, 2500)
      }

      socket.on('connect', onConnect)
      socket.on('disconnect', onDisconnect)
      socket.on('socket_error', onSocketError)
      socket.on('table_state', onTableState)
      socket.on('deal_cards', onDealCards)
      socket.on('showdown_result', onShowdownResult)
      socket.on('action_result', onActionResult)
      socket.on('turn_timer_start', onTurnTimerStart)
      socket.on('next_hand_countdown', onNextHandCountdown)
      socket.on('runout_cards_revealed', onRunoutCardsRevealed)
      socket.on('hand_revealed', onHandRevealed)
      socket.on('session_update', onSessionUpdate)
      socket.on('kicked_from_table', onKickedFromTable)

      if (socket.connected) {
        socket.emit(myStatus === 'seated' ? 'join_table' : 'spectate_table', { tableId: initialState.tableId })
      }

      cleanup = () => {
        socketRef.current = null
        socket.off('connect', onConnect); socket.off('disconnect', onDisconnect)
        socket.off('socket_error', onSocketError)
        socket.off('table_state', onTableState); socket.off('deal_cards', onDealCards)
        socket.off('showdown_result', onShowdownResult); socket.off('action_result', onActionResult)
        socket.off('turn_timer_start', onTurnTimerStart); socket.off('next_hand_countdown', onNextHandCountdown)
        socket.off('runout_cards_revealed', onRunoutCardsRevealed); socket.off('hand_revealed', onHandRevealed)
        socket.off('session_update', onSessionUpdate); socket.off('kicked_from_table', onKickedFromTable)
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
      }
    })

    return () => { active = false; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState.tableId, myStatus])

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleLeave() {
    setLeaving(true)
    const s = socketRef.current
    if (!s) { router.push('/lobby'); return }
    const onLeft = ({ tableId }: { tableId: string }) => {
      if (tableId !== initialState.tableId) return
      s.off('table_left', onLeft)
      router.push('/lobby')
    }
    s.on('table_left', onLeft)
    s.emit('leave_table', { tableId: initialState.tableId })
  }

  function handleStartHand() {
    setSocketError(null)
    socketRef.current?.emit('start_hand', { tableId: initialState.tableId })
  }

  function sendAction(action: BettingAction, amount?: number) {
    setSocketError(null)
    socketRef.current?.emit('player_action', {
      tableId: initialState.tableId,
      action,
      ...(amount != null ? { amount } : {}),
    })
  }

  function quickBet(fraction: number) {
    if (!hand || !myHP) return
    const potAfterCall = hand.pot + callAmt
    const total = hand.currentBet + Math.round(potAfterCall * fraction)
    setRaiseAmount(Math.min(Math.max(total, minRaiseTo), myMaxBet))
  }

  function handleShowCards(cards: [Card, Card]) {
    if (!prevShowdownRef.current && !showdownResult) return
    const handNum = (showdownResult ?? prevShowdownRef.current)?.handNumber ?? 0
    socketRef.current?.emit('reveal_hand', {
      tableId: initialState.tableId,
      handNumber: handNum,
      cards,
    })
  }

  function handleTip(amount: number) {
    if (!showdownResult) return
    socketRef.current?.emit('send_tip', {
      tableId: initialState.tableId,
      handNumber: showdownResult.handNumber,
      amount,
    })
    setTipSent(true)
    setShowTipModal(false)
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Phase labels
  // ─────────────────────────────────────────────────────────────────────────────

  const PHASE_LABEL: Record<string, string> = {
    PRE_FLOP: 'Pre-Flop', FLOP: 'Flop', TURN: 'Turn', RIVER: 'River',
  }
  const PHASE_BG: Record<string, string> = {
    PRE_FLOP: '#4c1d95', FLOP: '#1e3a8a', TURN: '#164e63', RIVER: '#7c2d12',
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  // Whether it's currently my turn and I need to act (no pending pre-action blocking)
  const needsMyAction = myStatus === 'seated' && isMyTurn && myHP?.playerPhase === 'active' && preAction === null

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: '#060b15', minWidth: 580 }}>

      {/* ── Kicked toast ────────────────────────────────────────────────────── */}
      {kickedMsg && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#1a0a0a', border: '1px solid #b91c1c',
            borderRadius: 12, padding: '24px 32px', textAlign: 'center',
            boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>🚫</div>
            <div style={{ color: '#fca5a5', fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{kickedMsg}</div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>Redirecting to lobby…</div>
          </div>
        </div>
      )}

      {/* ── Socket error toast ──────────────────────────────────────────────── */}
      {socketError && (
        <div
          onClick={() => setSocketError(null)}
          style={{
            position: 'fixed', top: 52, left: '50%', transform: 'translateX(-50%)',
            zIndex: 500, background: '#450a0a', border: '1px solid #b91c1c',
            borderRadius: 8, padding: '8px 16px',
            color: '#fca5a5', fontSize: 13, fontWeight: 600,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            cursor: 'pointer', userSelect: 'none',
          }}
        >
          {socketError}
        </div>
      )}

      {/* ══════════════════════════════════════════════════ TOP BAR ══════ */}
      <header style={{
        height: 44, flexShrink: 0, background: '#0a1020',
        borderBottom: '1px solid #1a2540',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 16px', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {state.tableName}
          </span>
          {hand && (
            <span style={{ background: PHASE_BG[hand.phase] ?? '#374151', color: 'white', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {PHASE_LABEL[hand.phase] ?? hand.phase}
            </span>
          )}
          {nextHandIn != null && !hand && (
            <span style={{ background: '#451a03', color: '#fbbf24', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>
              Next hand in {nextHandIn}s…
            </span>
          )}
          {prevHandResult && (
            <button
              onClick={() => setShowPrevHand(p => !p)}
              style={{
                background: showPrevHand ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${showPrevHand ? 'rgba(59,130,246,0.45)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 5, padding: '2px 9px',
                color: showPrevHand ? '#93c5fd' : '#475569',
                fontSize: 10, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Last Hand
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <span style={{ color: '#475569', fontSize: 12 }}>{state.smallBlind}/{state.bigBlind}</span>
          {myStatus === 'seated' && mySeatNumber != null && (
            <span style={{ color: '#475569', fontSize: 12 }}>
              Seat <span style={{ color: '#cbd5e1' }}>{mySeatNumber}</span>
            </span>
          )}
          {/* Session badge */}
          {sessionInfo && (
            sessionExpired ? (
              <span style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 5, padding: '2px 8px', color: '#6ee7b7', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
                Session ended — free to leave
              </span>
            ) : (
              <span title="Session time remaining" style={{
                background: sessionDisplay < 300 ? 'rgba(239,68,68,0.12)' : 'rgba(201,168,76,0.1)',
                border: `1px solid ${sessionDisplay < 300 ? 'rgba(239,68,68,0.3)' : 'rgba(201,168,76,0.25)'}`,
                borderRadius: 5, padding: '2px 8px',
                color: sessionDisplay < 300 ? '#fca5a5' : '#fde68a',
                fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: 'monospace',
              }}>
                🕐 {formatSessionTime(sessionDisplay)}
              </span>
            )
          )}
          <button
            onClick={canLeave ? handleLeave : () => setSocketError('Session in progress — you cannot leave until the session ends.')}
            disabled={leaving}
            title={canLeave ? undefined : 'Locked during session'}
            style={{
              background: canLeave ? '#1a0a0a' : '#0f1a10',
              border: `1px solid ${canLeave ? '#3f1010' : '#1a3a1a'}`,
              borderRadius: 6, padding: '3px 10px',
              color: canLeave ? '#f87171' : '#4b6b4b',
              fontSize: 11, fontWeight: 600,
              cursor: leaving ? 'not-allowed' : 'pointer',
              opacity: leaving ? 0.5 : 1,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            {!canLeave && <span style={{ fontSize: 10 }}>🔒</span>}
            {leaving ? 'Leaving…' : 'Leave'}
          </button>
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: connected ? '#34d399' : '#ef4444',
            boxShadow: connected ? '0 0 6px #34d399' : '0 0 6px #ef4444',
          }} title={connected ? 'Live' : 'Reconnecting…'} />
        </div>
      </header>

      {/* ── Previous hand history panel ────────────────────────────────────── */}
      {showPrevHand && prevHandResult && (
        <div style={{
          position: 'fixed', top: 52, right: 12, zIndex: 600,
          background: 'linear-gradient(145deg, #0d1929, #080f1d)',
          border: '1px solid rgba(201,168,76,0.28)',
          borderRadius: 10, padding: '10px 13px', width: 270,
          boxShadow: '0 8px 30px rgba(0,0,0,0.75)',
          pointerEvents: 'auto',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ color: '#fde68a', fontSize: 12, fontWeight: 700 }}>
              Hand #{prevHandResult.handNumber}
            </span>
            <button onClick={() => setShowPrevHand(false)}
              style={{ background: 'transparent', border: 'none', color: '#475569', fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: 0 }}>✕</button>
          </div>
          {prevHandResult.pots[0] && (
            <div style={{ marginBottom: 7, fontSize: 10 }}>
              <span style={{ color: '#475569' }}>Pot </span>
              <span style={{ color: '#e8c97a', fontWeight: 700 }}>{prevHandResult.pots[0].amount.toLocaleString()}</span>
              <span style={{ color: '#475569' }}> · </span>
              <span style={{ color: '#93c5fd' }}>{prevHandResult.pots[0].winnerHandName}</span>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: prevHandResult.communityCards.length > 0 ? 8 : 0 }}>
            {prevHandResult.players.map(p => (
              <div key={p.playerId} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10 }}>
                <span style={{ color: p.playerId === currentUserId ? '#93c5fd' : '#94a3b8', fontWeight: 600, minWidth: 50, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.playerId === currentUserId ? 'You' : p.username}
                </span>
                {p.holeCards && (
                  <div style={{ display: 'flex', gap: 2 }}>
                    <PlayingCard c={p.holeCards[0]} size="xs" />
                    <PlayingCard c={p.holeCards[1]} size="xs" />
                  </div>
                )}
                {p.handName && (
                  <span style={{ color: '#64748b', fontSize: 9, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 60 }}>{p.handName}</span>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ color: p.netChipChange > 0 ? '#4ade80' : p.netChipChange < 0 ? '#f87171' : '#6b7280', fontWeight: 700, flexShrink: 0 }}>
                  {p.netChipChange > 0 ? '+' : ''}{p.netChipChange.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
          {prevHandResult.communityCards.length > 0 && (
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              {prevHandResult.communityCards.map((c, i) => (
                <PlayingCard key={i} c={c} size="xs" />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════ TABLE AREA + ACTION PANEL ══ */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

        {/* ═══════════════════════════════════════════════ TABLE ════════ */}
        <div style={{
          flex: 1, minHeight: 0, display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          padding: '8px 12px 4px', overflow: 'hidden',
        }}>
          <div style={{ width: '100%', maxWidth: 900, position: 'relative' }}>
            <div style={{ paddingBottom: '58%', position: 'relative' }}>

              {/* Ambient glow */}
              <div style={{
                position: 'absolute', top: '-4%', left: '-4%', right: '-4%', bottom: '-4%',
                background: 'radial-gradient(ellipse, rgba(16,100,50,0.65) 0%, transparent 68%)',
                filter: 'blur(28px)', pointerEvents: 'none', borderRadius: '50%',
              }} />

              {/* Wood outer rim */}
              <div style={{
                position: 'absolute', top: '6%', left: '2%', right: '2%', bottom: '6%',
                borderRadius: '50%',
                background: 'linear-gradient(160deg, #5c3317 0%, #2c1608 40%, #180902 100%)',
                boxShadow: '0 0 0 3px #7a4a20, 0 0 0 6px #1e0d04, 0 30px 70px rgba(0,0,0,0.95), 0 0 120px rgba(0,0,0,0.6)',
              }} />

              {/* Green felt */}
              <div style={{
                position: 'absolute', top: '10%', left: '4%', right: '4%', bottom: '10%',
                borderRadius: '50%',
                background: 'radial-gradient(ellipse at 50% 38%, #1d6638 0%, #0e4a26 50%, #062f16 100%)',
                boxShadow: 'inset 0 0 80px rgba(0,0,0,0.6), inset 0 0 30px rgba(0,0,0,0.3)',
                overflow: 'hidden',
              }}>
                {/* Felt stitching */}
                <div style={{
                  position: 'absolute', inset: '4%',
                  borderRadius: '50%',
                  border: '1.5px solid rgba(201,168,76,0.1)',
                  pointerEvents: 'none',
                }} />
                {/* Spade watermark */}
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%,-54%)',
                  fontSize: 'clamp(80px,18vw,200px)',
                  color: 'rgba(0,0,0,0.06)',
                  pointerEvents: 'none', userSelect: 'none', lineHeight: 1,
                }}>♠</div>
              </div>

              {/* Center: Pot + Community Cards */}
              <div style={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>

                  {nextHandIn != null && !hand && !showdownResult && <ShuffleAnimation />}

                  {hand && (
                    <>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(201,168,76,0.3)',
                        borderRadius: 24, padding: '6px 18px',
                        backdropFilter: 'blur(6px)',
                      }}>
                        <span style={{ fontSize: 15 }}>🪙</span>
                        <div>
                          <div style={{ fontSize: 9, letterSpacing: '2px', textTransform: 'uppercase', color: 'rgba(245,236,215,0.45)' }}>
                            Main Pot
                          </div>
                          <div style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 17, fontWeight: 600, color: '#e8c97a', letterSpacing: '-0.5px' }}>
                            {hand.pot.toLocaleString()}
                          </div>
                        </div>
                        {hand.currentBet > 0 && (
                          <span style={{ color: 'rgba(245,236,215,0.35)', fontSize: 10, alignSelf: 'flex-end', marginBottom: 2 }}>
                            bet {hand.currentBet.toLocaleString()}
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 6 }}>
                        {hand.communityCards.map((c, i) => (
                          <PlayingCard key={i} c={c} size="community" />
                        ))}
                        {Array.from({ length: 5 - hand.communityCards.length }).map((_, i) => (
                          <div key={i} style={{
                            width: CARD_DIMS.community.w, height: CARD_DIMS.community.h,
                            borderRadius: CARD_DIMS.community.r,
                            border: '1px dashed rgba(255,255,255,0.1)', background: 'rgba(0,0,0,0.2)',
                          }} />
                        ))}
                      </div>
                    </>
                  )}

                  {!hand && showdownResult && (
                    <ShowdownBanner
                      key={showdownResult.handNumber}
                      showdown={showdownResult}
                      currentUserId={currentUserId}
                      myHoleCards={myHoleCards}
                      onShow={handleShowCards}
                      revealedCards={revealedCards}
                    />
                  )}

                  {!hand && !showdownResult && !nextHandIn && (
                    sessionExpired ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 28 }}>⏱️</span>
                        <p style={{ color: '#6ee7b7', fontSize: 14, fontWeight: 700 }}>Session Ended</p>
                        <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>Waiting for admin to extend or close the table.</p>
                      </div>
                    ) : (
                      <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>Waiting for players…</p>
                    )
                  )}
                </div>
              </div>

              {/* ── Seats + chip bets ─────────────────────────────────────── */}
              {state.seats.map(seat => {
                const vs       = toVisual(seat.seatNumber, anchor, max)
                const isMe     = seat.playerId === currentUserId
                const occ      = seat.playerId !== null
                const hp       = hand?.players.find(p => p.seatNumber === seat.seatNumber)
                const sdP      = showdownResult?.players.find(p => p.seatNumber === seat.seatNumber)
                const isTurn   = occ && hand?.currentTurnPlayerId === seat.playerId
                const isD      = occ && hand?.dealerSeatNumber === seat.seatNumber
                const isSB     = occ && hand?.smallBlindSeatNumber === seat.seatNumber
                const isBB     = occ && hand?.bigBlindSeatNumber === seat.seatNumber
                const folded   = hp?.playerPhase === 'folded'
                const allIn    = hp?.playerPhase === 'all-in'
                const sdFolded = !hand && sdP?.hasFolded === true
                const isWinner = !hand && !!showdownResult && !!seat.playerId &&
                  (showdownResult.pots[0]?.winners ?? []).includes(seat.playerId)
                const showTmr  = isTurn && turnTimerInfo?.playerId === seat.playerId && timeLeft > 0
                const lastAct  = seat.playerId ? lastActions[seat.playerId] : null
                const avatar   = getAvatar(seat.avatarId ?? fallbackAvatarId(seat.username))
                const dimmed   = folded || sdFolded

                return (
                  <div key={seat.seatNumber}>
                    {/* Chip bet stack — with SB/BB label during PRE_FLOP */}
                    {occ && hp && hp.roundContribution > 0 && (
                      <div style={{ ...chipPos(vs, max), position: 'absolute', zIndex: 10, pointerEvents: 'none' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          {showBlindLabels && isSB && (
                            <span style={{ background: '#1d4ed8', color: 'white', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>SB</span>
                          )}
                          {showBlindLabels && isBB && (
                            <span style={{ background: '#6d28d9', color: 'white', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>BB</span>
                          )}
                          <ChipStack amount={hp.roundContribution} />
                        </div>
                      </div>
                    )}

                    {/* Seat pod — circular avatar design */}
                    <div style={seatPos(vs, max)}>
                      {!occ ? (
                        /* Empty seat */
                        <div style={{
                          width: 52, height: 52, borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: '1px dashed rgba(255,255,255,0.12)',
                          color: 'rgba(255,255,255,0.18)', fontSize: 10, cursor: 'default',
                        }}>
                          #{seat.seatNumber}
                        </div>
                      ) : (() => {
                        /* Occupied seat — v3 side-cards design */
                        const rad2 = ((180 - (vs - 1) * (360 / max)) * Math.PI) / 180
                        const seatXPct = 50 + 46 * Math.sin(rad2)
                        const isHero = vs === 1
                        const isRightSide = seatXPct > 55 && !isHero

                        // Cards shown beside avatar (non-hero) or above (hero)
                        const runoutCards = seat.playerId ? runoutRevealedCards[seat.playerId] : undefined
                        const shownCards  = seat.playerId ? revealedCards[seat.playerId] : undefined

                        const heroCards: [Card, Card] | null = isHero
                          ? (hand && !folded && isMe && myHoleCards
                              ? myHoleCards
                              : (!hand && sdP?.holeCards)
                              ? (sdP.holeCards as [Card, Card])
                              : (!hand && shownCards)
                              ? shownCards
                              : null)
                          : null

                        const sideCardNode = !isHero ? (
                          hand && !folded && hp ? (
                            isMe && myHoleCards ? (
                              <div style={{ display: 'flex', gap: 2 }}>
                                <PlayingCard c={myHoleCards[0]} size="sm" />
                                <PlayingCard c={myHoleCards[1]} size="sm" />
                              </div>
                            ) : !isMe && runoutCards ? (
                              <div style={{ display: 'flex', gap: 2 }}>
                                <PlayingCard c={runoutCards[0]} size="sm" />
                                <PlayingCard c={runoutCards[1]} size="sm" />
                              </div>
                            ) : !isMe ? (
                              <div style={{ display: 'flex', gap: 2 }}>
                                <CardBack size="sm" />
                                <CardBack size="sm" />
                              </div>
                            ) : null
                          ) : (!hand && (sdP?.holeCards || shownCards) && !isMe) ? (
                            <div style={{ display: 'flex', gap: 2 }}>
                              <PlayingCard c={(sdP?.holeCards ?? shownCards!)[0]} size="sm" />
                              <PlayingCard c={(sdP?.holeCards ?? shownCards!)[1]} size="sm" />
                            </div>
                          ) : null
                        ) : null

                        // Seat pill text
                        let pillAction = ''
                        let pillColor = '#6b7280'
                        if (isTurn && isMe) { pillAction = 'YOUR TURN'; pillColor = '#86efac' }
                        else if (lastAct)   { pillAction = formatAction(lastAct); pillColor = actionLabelColor(lastAct.action) }
                        else if (allIn)     { pillAction = 'All-In';  pillColor = '#fdba74' }
                        else if (folded || sdFolded) { pillAction = 'Folded'; pillColor = '#fca5a5' }
                        else if (sdP?.handName) { pillAction = sdP.handName; pillColor = isWinner ? '#fbbf24' : '#93c5fd' }

                        let displayName = seat.username ?? ''
                        if (showBlindLabels && isSB) displayName += ' · SB'
                        if (showBlindLabels && isBB) displayName += ' · BB'
                        const stackDisplay = hp ? hp.stack.toLocaleString() : sdP ? sdP.finalStack.toLocaleString() : '—'

                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>

                            {/* Hero hole cards — above avatar row */}
                            {heroCards && (
                              <div style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
                                <PlayingCard c={heroCards[0]} size="sm" />
                                <PlayingCard c={heroCards[1]} size="sm" />
                              </div>
                            )}

                            {/* Avatar row */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexDirection: isRightSide ? 'row-reverse' : 'row' }}>

                              {/* Avatar circle */}
                              <div style={{ position: 'relative', flexShrink: 0 }}>
                                <div style={{
                                  width: isHero ? 48 : 42, height: isHero ? 48 : 42,
                                  borderRadius: '50%',
                                  background: `radial-gradient(circle at 38% 35%, ${avatar.color}ee, ${avatar.color}99)`,
                                  border: isTurn
                                    ? '2px solid #c9a84c'
                                    : isWinner
                                    ? '2px solid rgba(201,168,76,0.7)'
                                    : isMe
                                    ? '2px solid rgba(201,168,76,0.4)'
                                    : '2px solid rgba(201,168,76,0.18)',
                                  boxShadow: isTurn
                                    ? '0 0 0 3px rgba(201,168,76,0.2),0 0 14px rgba(201,168,76,0.4)'
                                    : isWinner
                                    ? '0 0 12px rgba(201,168,76,0.3)'
                                    : 'none',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: isHero ? 22 : 18, lineHeight: 1,
                                  opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.2s',
                                  overflow: 'hidden', position: 'relative',
                                }}>
                                  {showTmr && !isHero && <TimerRing t={timeLeft} />}
                                  <span style={{ position: 'relative', zIndex: 1 }}>{avatar.emoji}</span>
                                </div>
                                {isD && (
                                  <div style={{ position: 'absolute', bottom: -2, right: -3, zIndex: 5 }}>
                                    <DealerButton />
                                  </div>
                                )}
                              </div>

                              {/* Side cards (non-hero) */}
                              {sideCardNode}

                              {/* Timer beside avatar for hero */}
                              {isHero && showTmr && (
                                <div style={{ position: 'relative', width: 34, height: 34, marginLeft: 4, flexShrink: 0 }}>
                                  <svg viewBox="0 0 44 44" fill="none" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                                    <circle cx="22" cy="22" r="19" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" fill="none" />
                                    <circle cx="22" cy="22" r="19" fill="none"
                                      stroke={timeLeft <= 10 ? '#ef4444' : timeLeft <= 20 ? '#f59e0b' : '#c9a84c'}
                                      strokeWidth="3.5" strokeLinecap="round"
                                      strokeDasharray={`${Math.max(0, (timeLeft / TIMER_TOTAL) * 119.4).toFixed(1)} 119.4`}
                                    />
                                  </svg>
                                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 10, fontWeight: 700, color: '#f59e0b' }}>{timeLeft}</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Seat pill */}
                            <div style={{
                              background: 'rgba(0,0,0,0.7)',
                              border: `1px solid ${isTurn ? 'rgba(201,168,76,0.35)' : 'rgba(255,255,255,0.07)'}`,
                              borderRadius: 8, padding: '3px 10px', textAlign: 'center', minWidth: 72,
                              backdropFilter: 'blur(4px)',
                              boxShadow: isTurn ? '0 0 10px rgba(201,168,76,0.15)' : 'none',
                              opacity: dimmed ? 0.45 : 1, transition: 'opacity 0.2s',
                            }}>
                              <div style={{ fontSize: 9, letterSpacing: '1.2px', textTransform: 'uppercase', color: isMe ? '#c9a84c' : 'rgba(245,236,215,0.5)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>
                                {displayName}
                              </div>
                              <div style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12, fontWeight: 600, color: '#e8c97a', letterSpacing: '-0.3px' }}>
                                {stackDisplay}
                              </div>
                              {pillAction && (
                                <div style={{ fontSize: 8, letterSpacing: '0.8px', textTransform: 'uppercase', marginTop: 1, color: pillColor, fontWeight: 600 }}>
                                  {pillAction}
                                </div>
                              )}
                            </div>

                          </div>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}

            </div>
          </div>
        </div>

        {/* ════════════════════════════════════════ BOTTOM ACTION PANEL ══ */}
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
          .ap-range{-webkit-appearance:none;appearance:none;height:3px;border-radius:2px;outline:none;cursor:pointer;}
          .ap-range::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#c9a84c;box-shadow:0 0 8px rgba(201,168,76,0.55);border:2px solid #fff;cursor:pointer;}
          .ap-range::-moz-range-thumb{width:15px;height:15px;border-radius:50%;background:#c9a84c;box-shadow:0 0 8px rgba(201,168,76,0.55);border:2px solid #fff;cursor:pointer;}
          .ap-qb{font-size:10px;font-weight:600;padding:4px 9px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:6px;color:rgba(245,236,215,0.5);cursor:pointer;transition:all 0.14s;white-space:nowrap;}
          .ap-qb:hover{background:rgba(201,168,76,0.14);border-color:rgba(201,168,76,0.4);color:#e8c97a;}
          .ap-btn{flex:1;padding:13px 8px 11px;border:none;border-radius:10px;font-family:'Inter',sans-serif;font-size:13px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;transition:filter 0.14s,box-shadow 0.14s;position:relative;overflow:hidden;}
          .ap-btn::after{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:rgba(255,255,255,0.1);}
          .ap-btn:hover{filter:brightness(1.15);}
          .ap-btn:disabled{opacity:0.4;cursor:not-allowed;filter:none;}
          .ap-sub{font-size:10px;font-weight:400;opacity:0.72;text-transform:none;letter-spacing:0.2px;}
          .ap-fold{background:linear-gradient(180deg,#4a1515,#2d0c0c);border:1px solid rgba(220,38,38,0.35);color:#fca5a5;}
          .ap-fold:hover{box-shadow:0 0 18px rgba(220,38,38,0.22);}
          .ap-check{background:linear-gradient(180deg,#18381a,#0d2410);border:1px solid rgba(34,197,94,0.28);color:#86efac;}
          .ap-check:hover{box-shadow:0 0 18px rgba(34,197,94,0.18);}
          .ap-call{background:linear-gradient(180deg,#16243a,#0d1929);border:1px solid rgba(59,130,246,0.32);color:#93c5fd;}
          .ap-call:hover{box-shadow:0 0 18px rgba(59,130,246,0.2);}
          .ap-raise{flex:1.35 !important;background:linear-gradient(180deg,#3a2508,#241600);border:1px solid rgba(201,168,76,0.42);color:#e8c97a;}
          .ap-raise:hover{box-shadow:0 0 22px rgba(201,168,76,0.28);}
          .ap-allin{background:linear-gradient(180deg,#3a1e00,#241200);border:1px solid rgba(249,115,22,0.38);color:#fdba74;}
          .ap-allin:hover{box-shadow:0 0 18px rgba(249,115,22,0.22);}
        `}</style>
        <div style={{ flexShrink: 0, background: '#07101f', borderTop: '1px solid #1a2540' }}>
          <div style={{ display: 'flex', alignItems: 'stretch', minHeight: 116 }}>

            {/* ── Cards column ──────────────────────────────────────── */}
            {myHoleCards && myStatus === 'seated' && (
              <div style={{
                flexShrink: 0, borderRight: '1px solid #1a2540',
                padding: '8px 10px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4,
              }}>
                <span style={{ color: '#475569', fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                  Your Hand
                </span>
                <div style={{ display: 'flex', gap: 5 }}>
                  <PlayingCard c={myHoleCards[0]} size="md" />
                  <PlayingCard c={myHoleCards[1]} size="md" />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {myHP && (
                    <span style={{ color: '#fbbf24', fontSize: 11, fontWeight: 700, letterSpacing: '-0.3px' }}>
                      {myHP.stack.toLocaleString()}
                    </span>
                  )}
                  {showdownResult && myShowdownResult && (
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '-0.3px', color: myShowdownResult.netChipChange > 0 ? '#4ade80' : '#f87171' }}>
                      {myShowdownResult.netChipChange > 0 ? '+' : ''}{myShowdownResult.netChipChange.toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* ── Main content column ───────────────────────────────── */}
            <div style={{ flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, justifyContent: 'center' }}>

              {/* ── MY TURN: action bar ──────────────────────────────── */}
              {needsMyAction && (() => {
                const raiseDisabled = raiseAmount < minRaiseTo || raiseAmount > myMaxBet
                const sliderMax = Math.max(minRaiseTo + 1, myMaxBet)
                return (
                  <>
                    {/* Row 1: quick presets + timer — only shown when raising is possible */}
                    {canRaise && (
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5 }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {([
                            { l: 'Min', fn: () => setRaiseAmount(minRaiseTo) },
                            { l: '½ Pot', fn: () => quickBet(0.5) },
                            { l: 'Pot',   fn: () => quickBet(1.0) },
                            { l: 'Max',   fn: () => setRaiseAmount(myMaxBet) },
                          ] as const).map(q => (
                            <button key={q.l} onClick={q.fn} className="ap-qb">{q.l}</button>
                          ))}
                        </div>
                        <div style={{ flex: 1 }} />
                        {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                          <span style={{ color: timeLeft <= 15 ? '#f87171' : '#fde047', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, minWidth: 26, textAlign: 'right' }}>{timeLeft}s</span>
                        )}
                      </div>
                    )}

                    {/* Timer row when no raise controls */}
                    {!canRaise && turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <span style={{ color: timeLeft <= 15 ? '#f87171' : '#fde047', fontWeight: 700, fontFamily: 'monospace', fontSize: 11 }}>{timeLeft}s</span>
                      </div>
                    )}

                    {/* Timer bar */}
                    {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                      <div style={{ height: 3, borderRadius: 2, background: '#1e293b', overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 2,
                          width: `${Math.min(100, (timeLeft / TIMER_TOTAL) * 100)}%`,
                          background: timeLeft <= 15 ? '#ef4444' : '#eab308',
                          transition: 'width 0.25s linear, background 0.3s',
                        }} />
                      </div>
                    )}

                    {/* Row 2: raise amount + slider — only shown when raising is possible */}
                    {canRaise && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '9px 14px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                          <span style={{ fontSize: 9, letterSpacing: '2px', textTransform: 'uppercase', color: 'rgba(245,236,215,0.4)', whiteSpace: 'nowrap' }}>Raise to</span>
                          <input
                            type="number" value={raiseAmount} min={minRaiseTo} max={myMaxBet}
                            step={state.bigBlind}
                            onChange={e => setRaiseAmount(Number(e.target.value))}
                            style={{ width: 70, background: 'transparent', border: 'none', outline: 'none', fontFamily: '"JetBrains Mono",monospace', fontSize: 15, fontWeight: 600, color: '#e8c97a', textAlign: 'right', padding: 0 }}
                          />
                        </div>
                        <input
                          type="range" className="ap-range"
                          min={minRaiseTo} max={sliderMax}
                          step={state.bigBlind}
                          value={Math.min(Math.max(raiseAmount, minRaiseTo), sliderMax)}
                          onChange={e => setRaiseAmount(Number(e.target.value))}
                          style={{ flex: 1, background: `linear-gradient(to right,#c9a84c ${Math.round(((Math.min(Math.max(raiseAmount, minRaiseTo), sliderMax) - minRaiseTo) / Math.max(1, sliderMax - minRaiseTo)) * 100)}%,rgba(255,255,255,0.1) ${Math.round(((Math.min(Math.max(raiseAmount, minRaiseTo), sliderMax) - minRaiseTo) / Math.max(1, sliderMax - minRaiseTo)) * 100)}%)` }}
                        />
                      </div>
                    )}

                    {/* Row 3: action buttons */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => sendAction('FOLD')} className="ap-btn ap-fold">
                        Fold<span className="ap-sub">Muck</span>
                      </button>

                      {canCheck ? (
                        <button onClick={() => sendAction('CHECK')} className="ap-btn ap-check">
                          Check<span className="ap-sub">No bet</span>
                        </button>
                      ) : mustGoAllIn ? (
                        /* Can't afford the call — only all-in is possible */
                        <button onClick={() => sendAction('ALL_IN')} className="ap-btn ap-allin" style={{ flex: 1.35 }}>
                          All-In<span className="ap-sub">{myStack.toLocaleString()}</span>
                        </button>
                      ) : (
                        <button onClick={() => sendAction('CALL')} className="ap-btn ap-call">
                          Call<span className="ap-sub">{callAmt.toLocaleString()}</span>
                        </button>
                      )}

                      {canRaise && (
                        <>
                          <button
                            onClick={() => sendAction('RAISE', raiseAmount)}
                            disabled={raiseDisabled}
                            className="ap-btn ap-raise"
                          >
                            Raise<span className="ap-sub">to {raiseAmount.toLocaleString()}</span>
                          </button>

                          <button onClick={() => sendAction('ALL_IN')} className="ap-btn ap-allin">
                            All-In<span className="ap-sub">{myStack.toLocaleString()}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )
              })()}

              {/* ── IDLE: waiting / showdown / start / pre-actions ──── */}
              {!needsMyAction && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

                  {/* Pre-action buttons: shown when hand is live, it's not my turn, and I'm active */}
                  {myStatus === 'seated' && hand && !isMyTurn && myHP?.playerPhase === 'active' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ color: '#475569', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        Pre-Action
                      </span>
                      <div style={{ display: 'flex', gap: 5 }}>
                        {([
                          { id: 'auto-check' as PreAction, label: 'Auto-Check', desc: 'Check if no bet; otherwise act normally' },
                          { id: 'check-fold' as PreAction, label: 'Check / Fold', desc: 'Check if free; fold if there is a bet' },
                          { id: 'auto-fold'  as PreAction, label: 'Auto-Fold',  desc: 'Fold immediately when your turn comes' },
                        ]).map(opt => {
                          const active = preAction === opt.id
                          return (
                            <button
                              key={opt.id}
                              title={opt.desc}
                              onClick={() => setPreAction(active ? null : opt.id)}
                              style={{
                                flex: 1,
                                background: active ? 'rgba(234,179,8,0.14)' : 'rgba(255,255,255,0.04)',
                                border: active ? '1.5px solid #eab308' : '1px solid rgba(255,255,255,0.12)',
                                borderRadius: 8, padding: '7px 4px',
                                color: active ? '#fde68a' : '#64748b',
                                fontSize: 11, fontWeight: active ? 700 : 600,
                                cursor: 'pointer', whiteSpace: 'nowrap',
                                transition: 'all 0.12s',
                                boxShadow: active ? '0 0 8px rgba(234,179,8,0.2)' : 'none',
                              }}
                              onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#94a3b8' } }}
                              onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = '#64748b' } }}
                            >
                              {opt.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* Status text / start button */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>

                      {!hand && showdownResult && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', alignItems: 'center' }}>
                          {showdownResult.players.map(p => (
                            <span key={p.playerId} style={{ fontSize: 11 }}>
                              <span style={{ color: '#64748b' }}>{p.username} </span>
                              <span style={{ color: p.netChipChange > 0 ? '#4ade80' : p.netChipChange < 0 ? '#f87171' : '#6b7280', fontWeight: 700 }}>
                                {p.netChipChange > 0 ? '+' : ''}{p.netChipChange.toLocaleString()}
                              </span>
                            </span>
                          ))}
                        </div>
                      )}

                      {canStart && (
                        <button
                          onClick={handleStartHand}
                          disabled={!connected}
                          style={{ background: connected ? '#064e3b' : '#1a2a1a', border: '1px solid #065f46', borderRadius: 8, padding: '7px 20px', alignSelf: 'flex-start', color: connected ? '#a7f3d0' : '#4b6b4b', fontSize: 13, fontWeight: 700, cursor: connected ? 'pointer' : 'not-allowed', opacity: connected ? 1 : 0.5 }}
                          onMouseEnter={e => { if (connected) e.currentTarget.style.background = '#065f46' }}
                          onMouseLeave={e => { if (connected) e.currentTarget.style.background = '#064e3b' }}
                        >Start Hand</button>
                      )}

                      {!hand && !canStart && !showdownResult && myStatus === 'seated' && (
                        <p style={{ color: '#475569', fontSize: 12 }}>
                          {seatedCnt < 2 ? 'Waiting for more players…' : nextHandIn != null ? `Next hand in ${nextHandIn}s…` : 'Waiting for hand to start…'}
                        </p>
                      )}
                      {hand && myStatus === 'seated' && !isMyTurn && myHP?.playerPhase !== 'active' && (
                        <p style={{ color: '#475569', fontSize: 12 }}>Waiting for hand to finish…</p>
                      )}
                      {myStatus === 'spectating' && (
                        <p style={{ color: '#475569', fontSize: 12 }}>Watching as spectator</p>
                      )}
                      {state.spectators.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                          <span style={{ color: '#334155', fontSize: 10 }}>Watching:</span>
                          {state.spectators.map(s => (
                            <span key={s.playerId} style={{ color: '#475569', fontSize: 10 }}>
                              {s.username}{s.playerId === currentUserId ? ' (you)' : ''}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Dealer tip modal */}
      {showTipModal && !tipSent && myShowdownResult && myShowdownResult.netChipChange > 0 && (
        <DealerTipModal
          winAmount={myShowdownResult.netChipChange}
          onTip={handleTip}
          onSkip={() => setShowTipModal(false)}
        />
      )}
    </div>
  )
}
