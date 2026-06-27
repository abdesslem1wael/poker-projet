'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type {
  TableStatePayload,
  Card,
  CardRank,
  CardSuit,
  BettingAction,
  ShowdownPayload,
  PublicHandState,
  PublicPlayerHandState,
  SeatInfo,
  ChatMessage,
} from '@/lib/socket/types'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'
import { soundManager } from '@/lib/sounds'
import type { SoundName } from '@/lib/sounds'

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

const CHAT_MAX_LEN = 200
const CHAT_HISTORY_LIMIT = 50

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SUIT_SYM: Record<string, string> = {
  clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠',
}
// Four-color deck: the traditional two-color (black/red) scheme makes spades
// indistinguishable from clubs, and hearts from diamonds, at a glance — especially
// at the small card sizes used for opponents. Each suit gets its own color instead.
const SUIT_COLOR: Record<string, string> = {
  spades:   '#0f172a',  // black
  clubs:    '#15803d',  // green
  hearts:   '#dc2626',  // red
  diamonds: '#2563eb',  // blue
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

function formatAction(la: LastAction): string {
  switch (la.action) {
    case 'FOLD':   return 'Folded'
    case 'CHECK':  return 'Checked'
    case 'CALL':   return `Called ${la.amount !== undefined ? formatNumber(la.amount) : ''}`
    case 'RAISE':  return `Raised → ${la.amount !== undefined ? formatNumber(la.amount) : ''}`
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

  // Hero seat sits lower and cleaner below the oval table:
  // [ Avatar ] [ Cards ] [ Name / Stack ]
  // Opponent pods sit near the rail/edge of the felt rather than on top of it.
  const xRadius = vs === 1 ? 41 : 45
  const yScale = vs === 1 ? 46 : 50

  return {
    position: 'absolute',
    left: `${(50 + xRadius * Math.sin(rad)).toFixed(2)}%`,
    top: `${(50 - yScale * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
    zIndex: vs === 1 ? 30 : 10,
  }
}

// Bet chips sit on the "betting line" — inside the seat pod radius, between
// the player and the community cards in the centre of the table.
function chipPos(vs: number, max: number): React.CSSProperties {
  const rad = ((180 + (vs - 1) * (360 / max)) * Math.PI) / 180
  return {
    position: 'absolute',
    left: `${(50 + 30 * Math.sin(rad)).toFixed(2)}%`,
    top:  `${(50 - 28 * Math.cos(rad)).toFixed(2)}%`,
    transform: 'translate(-50%,-50%)',
  }
}

// Plain {left, top} percentages for a seat — used as chip-flight endpoints (table-relative,
// same coordinate space as seatPos/chipPos). Desktop-accurate; on the mobile-landscape preset
// layout this is a close approximation since those positions are applied via CSS, not JS.
function seatAnchorPos(vs: number, max: number): { left: string; top: string } {
  const sp = seatPos(vs, max)
  return { left: sp.left as string, top: sp.top as string }
}

// Same idea, but for the betting-line spot in front of a seat — where the static bet-chip
// stack already renders. Chip flights land exactly here so they hand off seamlessly.
function chipPosAnchor(vs: number, max: number): { left: string; top: string } {
  const cp = chipPos(vs, max)
  return { left: cp.left as string, top: cp.top as string }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile-landscape seat presets — FIXED coordinates per table size (2-9
// players), not the continuous oval math above. On a phone in landscape,
// opponent pods stack their content vertically (avatar / cards / pill) and
// are centred on a hand-picked point, so every pod, card, pill, chip and
// timer stays on-screen and non-overlapping at every seat count — verified
// numerically for table-area heights from 200px to 400px. The oval formula
// above is kept as-is for desktop. Hero (vs=1) is excluded — it is always
// positioned via the `.tbl-hero-seat` CSS class.
// ─────────────────────────────────────────────────────────────────────────────

type MobileSeatSlot = {
  left: number              // % of the table box (always centred horizontally on this point)
  top: number                // % of the table box
  vAnchor: 'mid' | 'top'      // 'top' = anchored at the seat's top edge (near the top rail);
                              // 'mid' = anchored at vertical centre (down the left/right rails)
}

// One entry per opponent visual seat (vs = 2..max), indexed by table size.
const MOBILE_SEAT_PRESETS: Record<number, MobileSeatSlot[]> = {
  2: [
    { left: 75, top: 85, vAnchor: 'mid' },
  ],

  3: [
    { left: 15, top: 30, vAnchor: 'mid' },
    { left: 85, top: 30, vAnchor: 'mid' },
  ],

  4: [
    { left: 10, top: 62, vAnchor: 'mid' },
    { left: 75, top: 85, vAnchor: 'mid' },
    { left: 90, top: 62, vAnchor: 'mid' },
  ],

  5: [
    { left: 10, top: 70, vAnchor: 'mid' },
    { left: 25, top: 18, vAnchor: 'top' },
    { left: 75, top: 18, vAnchor: 'top' },
    { left: 90, top: 70, vAnchor: 'mid' },
  ],

  6: [
    { left: 10, top: 70, vAnchor: 'mid' },
    { left: 20, top: 23, vAnchor: 'top' },
    { left: 75, top: 85, vAnchor: 'mid' },
    { left: 80, top: 23, vAnchor: 'top' },
    { left: 90, top: 70, vAnchor: 'mid' },
  ],

  7: [
    { left: 30, top: 84, vAnchor: 'mid' },
    { left: 10, top: 68, vAnchor: 'mid' },
    { left: 18, top: 23, vAnchor: 'top' },
    { left: 50, top: 10, vAnchor: 'top' },
    { left: 82, top: 23, vAnchor: 'top' },
    { left: 75, top: 84, vAnchor: 'mid' },
  ],

  8: [
    { left: 30, top: 84, vAnchor: 'mid' },
    { left: 10, top: 70, vAnchor: 'mid' },
    { left: 15, top: 23, vAnchor: 'top' },
    { left: 35, top: 10, vAnchor: 'top' },
    { left: 65, top: 10, vAnchor: 'top' },
    { left: 85, top: 23, vAnchor: 'top' },
    { left: 75, top: 84, vAnchor: 'mid' },
  ],

  9: [
    { left: 30, top: 84, vAnchor: 'mid' },
    { left: 10, top: 70, vAnchor: 'mid' },
    { left: 15, top: 23, vAnchor: 'top' },
    { left: 35, top: 10, vAnchor: 'top' },
    { left: 59, top: 10, vAnchor: 'top' },
    { left: 75, top: 17, vAnchor: 'top' },
    { left: 90, top: 65, vAnchor: 'mid' },
    { left: 75, top: 85, vAnchor: 'mid' },
  ],
}

function mobileSeatSlot(vs: number, max: number): MobileSeatSlot {
  if (vs === 1) return { left: 50, top: 88, vAnchor: 'mid' } // hero — overridden by .tbl-hero-seat
  const presets = MOBILE_SEAT_PRESETS[max] ?? MOBILE_SEAT_PRESETS[9]
  return presets[vs - 2] ?? presets[presets.length - 1]
}

// CSS class selecting the vertical anchor edge — pods are always centred
// horizontally, so only "anchored at the top rail" vs "anchored at vertical
// centre down the side rail" need different transform-origin/translate rules.
function mobileAnchorClass(vs: number, max: number): string {
  if (vs === 1) return 'tbl-hero-seat'
  return mobileSeatSlot(vs, max).vAnchor === 'top' ? 'tbl-pod-vtop' : 'tbl-pod-vmid'
}

// Custom properties consumed only inside the mobile-landscape media query —
// desktop ignores them entirely and keeps using seatPos()/chipPos() above.
function mobileSeatVars(vs: number, max: number): React.CSSProperties {
  if (vs === 1) return {}
  const slot = mobileSeatSlot(vs, max)
  const mty = slot.vAnchor === 'top' ? '0%' : '-50%'
  return { '--mleft': `${slot.left}%`, '--mtop': `${slot.top}%`, '--mty': mty } as React.CSSProperties
}

// Bet chips sit between the seat and the pot — interpolate the preset
// coordinate toward the table centre rather than maintaining a second table.
function mobileChipVars(vs: number, max: number): React.CSSProperties {
  const slot = mobileSeatSlot(vs, max)
  const left = 50 + (slot.left - 50) * 0.55
  const top  = 50 + (slot.top - 50) * 0.55
  return { '--mleft': `${left.toFixed(1)}%`, '--mtop': `${top.toFixed(1)}%` } as React.CSSProperties
}

// Opponent pod content (avatar/cards/pill) scales down as more seats are in
// play so a 9-max table still fits a phone screen in landscape. The
// `@media (max-height:380px)` block overrides --mscale further for very
// short viewports — see mobileSeatVars()/the seat-pod CSS for how it's used.
function mobileDensityScale(max: number): number {
  if (max <= 4) return 0.85
  if (max <= 6) return 0.72
  return 0.64}

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
  const sym = SUIT_SYM[c.suit]
  const color = SUIT_COLOR[c.suit]
  const d = CARD_DIMS[size]
  const isFace = ['J', 'Q', 'K', 'A'].includes(c.rank)
  const pips = PIP_POSITIONS[c.rank]

  return (
    <div
      style={{
        width: d.w, height: d.h, position: 'relative', flexShrink: 0,
        background: 'white',
        borderRadius: d.r,
        border: '1px solid #d1d5db',
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
// Timer
// ─────────────────────────────────────────────────────────────────────────────

const TIMER_TOTAL = 60

// ─────────────────────────────────────────────────────────────────────────────
// ChipStack
// ─────────────────────────────────────────────────────────────────────────────

// Real-casino chip color/value convention: white→red→blue→green→black→purple→yellow→orange
// as the denomination climbs. Each tier carries a light/base/dark trio (for the face gradient)
// plus an edge color used for the striped rim.
type ChipPalette = { light: string; base: string; dark: string; edge: string }

const CHIP_TIERS: { min: number; colors: ChipPalette }[] = [
  { min: 0,     colors: { light: '#ffffff', base: '#f1f5f9', dark: '#cbd5e1', edge: '#1e293b' } },  // white
  { min: 5,     colors: { light: '#f87171', base: '#dc2626', dark: '#7f1d1d', edge: '#fef2f2' } },  // red
  { min: 10,    colors: { light: '#60a5fa', base: '#1d4ed8', dark: '#1e3a8a', edge: '#eff6ff' } },  // blue
  { min: 25,    colors: { light: '#4ade80', base: '#16a34a', dark: '#14532d', edge: '#f0fdf4' } },  // green
  { min: 100,   colors: { light: '#475569', base: '#1e293b', dark: '#020617', edge: '#fbbf24' } },  // black
  { min: 500,   colors: { light: '#a78bfa', base: '#7c3aed', dark: '#4c1d95', edge: '#f5f3ff' } },  // purple
  { min: 1000,  colors: { light: '#fde047', base: '#ca8a04', dark: '#713f12', edge: '#1e293b' } },  // yellow
  { min: 5000,  colors: { light: '#fb923c', base: '#ea580c', dark: '#7c2d12', edge: '#fff7ed' } },  // orange
]

function chipColor(amount: number): ChipPalette {
  let result = CHIP_TIERS[0].colors
  for (const tier of CHIP_TIERS) {
    if (amount >= tier.min) result = tier.colors
  }
  return result
}

// Compact chip label: 2.1M / 19.6M above 1M, 12k / 497k above 10k, 1.2k-style below that.
function formatChipAmount(amount: number): string {
  if (amount >= 1_000_000) {
    const v = amount / 1_000_000
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`
  }
  if (amount >= 10_000) {
    return `${Math.round(amount / 1000)}k`
  }
  if (amount >= 1000) {
    const v = amount / 1000
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}k`
  }
  return `${amount}`
}

// A single poker chip — striped edge (alternating segments) + a domed, gradient-shaded face.
function PokerChip({ size, palette }: { size: number; palette: ChipPalette }) {
  return (
    <div style={{
      position: 'relative', width: size, height: size, borderRadius: '50%',
      background: `repeating-conic-gradient(${palette.edge} 0deg 22.5deg, ${palette.base} 22.5deg 45deg)`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.55)',
    }}>
      <div style={{
        position: 'absolute', inset: Math.max(1, size * 0.16),
        borderRadius: '50%',
        background: `radial-gradient(circle at 35% 32%, ${palette.light}, ${palette.base} 60%, ${palette.dark})`,
        border: '1px solid rgba(255,255,255,0.3)',
      }} />
    </div>
  )
}

// Single decorative chip — used inline next to numeric stack/pot labels (symbolic, not a count).
function MiniChip({ amount, size = 11 }: { amount: number; size?: number }) {
  return <PokerChip size={size} palette={chipColor(amount)} />
}

function ChipStack({ amount, showLabel = true, chipSize = 15 }: { amount: number; showLabel?: boolean; chipSize?: number }) {
  const palette = chipColor(amount)
  const layers = Math.min(5, Math.max(2, Math.floor(Math.log10(amount + 1))))
  return (
    <div className="flex flex-col items-center">
      <div style={{ position: 'relative', width: chipSize, height: chipSize + layers * 2 }}>
        {Array.from({ length: layers }).map((_, i) => (
          <div key={i} style={{ position: 'absolute', bottom: i * 2, left: 0 }}>
            <PokerChip size={chipSize} palette={palette} />
          </div>
        ))}
      </div>
      {showLabel && (
        <span style={{
          marginTop: 2,
          background: 'rgba(0,0,0,0.8)',
          color: '#fbbf24', fontSize: 8, fontWeight: 700,
          padding: '1px 3px', borderRadius: 3, letterSpacing: '-0.3px', whiteSpace: 'nowrap',
        }}>
          {formatChipAmount(amount)}
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ChipFlight — a single chip stack animating from one table-relative position to
// another. Three legs: seat → in-front-of-seat (bets/blinds), in-front-of-seat → pot
// (round-end collection), pot → seat (winnings). Purely visual: it never touches
// game state, just shows a flight then unmounts itself.
// ─────────────────────────────────────────────────────────────────────────────

const POT_CENTER_POS = { left: '50%', top: '40%' }
const ACTION_CHIP_FLIGHT_MS  = 380   // seat → in-front-of-seat: blinds/bet/call/raise/all-in (spec: 350–600ms)
const COLLECT_CHIP_FLIGHT_MS = 520   // in-front-of-seat → pot, when the betting round ends (spec: 350–600ms)
const WINNER_CHIP_FLIGHT_MS  = 850   // pot → winner seat(s) (spec: 700–1000ms)
const WINNER_FLIGHT_DELAY_MS = 3500  // dwell on showdown cards before the pot flies to the winner

type ChipFlightData = {
  id: string
  from: { left: string; top: string }
  to: { left: string; top: string }
  amount: number
  duration: number
}

function ChipFlight({ flight, onDone }: { flight: ChipFlightData; onDone: (id: string) => void }) {
  const [stage, setStage] = useState<'start' | 'flying' | 'landed'>('start')

  useEffect(() => {
    const raf = requestAnimationFrame(() => setStage('flying'))
    const landTimer = setTimeout(() => setStage('landed'), flight.duration)
    const doneTimer = setTimeout(() => onDone(flight.id), flight.duration + 200)
    return () => { cancelAnimationFrame(raf); clearTimeout(landTimer); clearTimeout(doneTimer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pos = stage === 'start' ? flight.from : flight.to
  const landed = stage === 'landed'

  return (
    <div style={{
      position: 'absolute',
      left: pos.left, top: pos.top,
      transform: `translate(-50%,-50%) scale(${landed ? 0.5 : 1})`,
      opacity: landed ? 0 : 1,
      transition: stage === 'start'
        ? 'none'
        : `left ${flight.duration}ms cubic-bezier(.22,.61,.36,1), top ${flight.duration}ms cubic-bezier(.22,.61,.36,1), transform 200ms ease-in, opacity 200ms ease-in`,
      zIndex: 45,
      pointerEvents: 'none',
    }}>
      <ChipStack amount={flight.amount} chipSize={13} />
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
    <div className="tbl-showdown-panel" style={{
      pointerEvents: 'auto',
      background: 'rgba(4, 10, 22, 0.93)',
      border: '1px solid rgba(234,179,8,0.38)',
      borderRadius: 14, padding: '10px 14px',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7,
      maxWidth: 400,
      maxHeight: 'min(420px, 70vh)',
      overflowY: 'auto',
      boxShadow: '0 0 0 1px rgba(234,179,8,0.1), 0 8px 40px rgba(0,0,0,0.75)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 15 }}>🏆</span>
        <span style={{ color: '#fde68a', fontWeight: 800, fontSize: 14 }}>{winnerLabel}</span>
        <span style={{ color: '#4ade80', fontWeight: 700, fontSize: 13, background: 'rgba(74,222,128,0.1)', borderRadius: 6, padding: '1px 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <MiniChip amount={winnerNet} size={11} />
          +{formatNumber(winnerNet)}
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
                <span style={{ color: '#fbbf24', fontWeight: 700 }}>{formatNumber(pot.amount)}</span>
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
                    {p.netChipChange > 0 ? '+' : ''}{formatNumber(p.netChipChange)}
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
// WinnerToast — compact auto-dismissing pill shown at the end of each hand.
// The full breakdown is still available in the "Last Hand" side panel.
// ─────────────────────────────────────────────────────────────────────────────

function WinnerToast({ showdown, onDismiss }: { showdown: ShowdownPayload; onDismiss: () => void }) {
  const primaryPot  = showdown.pots[0]
  const winnerIds   = new Set(primaryPot?.winners ?? [])
  const winners     = showdown.players.filter(p => winnerIds.has(p.playerId))
  const winnerLabel = winners.map(w => w.username).join(' & ')
  const winnerNet   = primaryPot?.amount ?? 0
  const handName    = primaryPot?.winnerHandName

  return (
    <div style={{
      position: 'fixed', top: 54, left: '50%', transform: 'translateX(-50%)',
      zIndex: 400, pointerEvents: 'none',
      animation: 'winner-toast-in 0.38s cubic-bezier(.22,.61,.36,1)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: 'rgba(4,10,22,0.93)',
        border: '1px solid rgba(234,179,8,0.55)',
        borderRadius: 26, padding: '7px 16px 7px 12px',
        boxShadow: '0 0 0 1px rgba(234,179,8,0.1),0 8px 32px rgba(0,0,0,0.75),0 0 28px rgba(234,179,8,0.14)',
        backdropFilter: 'blur(14px)',
        whiteSpace: 'nowrap',
      }}>
        <span style={{ fontSize: 17 }}>🏆</span>
        <span style={{ color: '#fde68a', fontWeight: 800, fontSize: 14 }}>{winnerLabel}</span>
        <span style={{ color: '#4ade80', fontWeight: 700, fontSize: 13 }}>
          +{formatNumber(winnerNet)}
        </span>
        {handName && handName !== 'Last Standing' && (
          <>
            <span style={{ color: 'rgba(255,255,255,0.22)', fontSize: 13 }}>·</span>
            <span style={{ color: '#93c5fd', fontSize: 13, fontWeight: 600 }}>{handName}</span>
          </>
        )}
        <button
          onClick={onDismiss}
          style={{
            background: 'transparent', border: 'none', color: '#475569',
            fontSize: 14, cursor: 'pointer', padding: '0 0 0 4px',
            lineHeight: 1, pointerEvents: 'auto',
          }}
        >✕</button>
      </div>
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
          <div style={{ color: '#475569', fontSize: 10, marginTop: 1 }}>Won {formatNumber(winAmount)}</div>
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
              <div style={{ fontSize: 9, color: '#64748b', marginTop: 1 }}>{formatNumber(amt)}</div>
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

// ─────────────────────────────────────────────────────────────────────────────
// DEV-ONLY mobile layout preview
// Flip ENABLED to true locally to render a fake table with FAKE_SEAT_COUNT
// (2-9) seats, for visually testing the mobile seat layout above without a
// real table, real opponents, or a running hand. This only swaps the data
// fed into the seat-rendering JSX below — it never touches sockets, the
// database, or any betting/hand/pot/showdown logic, and `process.env.NODE_ENV`
// forces it off in production builds regardless of this flag.
// ─────────────────────────────────────────────────────────────────────────────

const LAYOUT_PREVIEW_ENABLED    = false
const LAYOUT_PREVIEW_SEAT_COUNT = 9

function buildLayoutPreview(seatCount: number, currentUserId: string): {
  seats: SeatInfo[]
  hand: PublicHandState
  myHoleCards: [Card, Card]
} {
  const ranks: CardRank[] = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2']
  const suits: CardSuit[] = ['spades', 'hearts', 'diamonds', 'clubs']
  let cardIdx = 0
  const nextCard = (): Card => {
    const c: Card = { rank: ranks[cardIdx % ranks.length], suit: suits[Math.floor(cardIdx / ranks.length) % suits.length] }
    cardIdx++
    return c
  }

  const seats: SeatInfo[] = Array.from({ length: seatCount }, (_, i) => ({
    seatNumber: i + 1,
    playerId: i === 0 ? currentUserId : `preview-bot-${i + 1}`,
    username: i === 0 ? 'You' : `Bot ${i + 1}`,
    avatarId: null,
  }))

  const players: PublicPlayerHandState[] = seats.map((s, i) => ({
    playerId: s.playerId as string,
    seatNumber: s.seatNumber,
    stack: 8000 - i * 350,
    roundContribution: i === 1 ? 100 : i === 2 ? 200 : 0,
    totalContributed: i === 1 ? 100 : i === 2 ? 200 : 0,
    playerPhase: seatCount > 4 && i === 4 ? 'folded' : seatCount > 5 && i === 5 ? 'all-in' : 'active',
    hasActedThisRound: i !== 3 % seatCount,
  }))

  const hand: PublicHandState = {
    handNumber: 0,
    phase: 'PRE_FLOP',
    pot: 300,
    currentBet: 200,
    minRaise: 200,
    currentTurnPlayerId: seats[3 % seatCount]?.playerId ?? null,
    dealerSeatNumber: seats[seatCount - 1].seatNumber,
    smallBlindSeatNumber: seats[1].seatNumber,
    bigBlindSeatNumber: seats[2 % seatCount].seatNumber,
    communityCards: [],
    players,
  }

  const myHoleCards: [Card, Card] = [nextCard(), nextCard()]
  return { seats, hand, myHoleCards }
}

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
  const [winnerToastVisible, setWinnerToastVisible] = useState(false)
  const [sessionInfo, setSessionInfo]    = useState<SessionInfo | null>(null)
  const [sessionDisplay, setSessionDisplay] = useState<number>(0)
  const [kickedMsg, setKickedMsg]        = useState<{ msg: string; reason: 'out_of_chips' | 'admin_kicked' } | null>(null)
  const [muted, setMuted]                = useState(false)
  const [myCurrentStatus, setMyCurrentStatus] = useState<'seated' | 'spectating'>(myStatus)
  const [outOfChipsMsg, setOutOfChipsMsg] = useState(false)
  const [isFullscreen, setIsFullscreen]   = useState(false)
  const [theaterMode, setTheaterMode]     = useState(false)
  const [showIosInstructions, setShowIosInstructions] = useState(false)
  const [chatMessages, setChatMessages]   = useState<ChatMessage[]>([])
  const [chatInput, setChatInput]         = useState('')
  const [chatOpen, setChatOpen]           = useState(false)
  const [unreadChatCount, setUnreadChatCount] = useState(0)
  // Animation state: hero hole cards revealed one by one, opponent backs per seat, community cards one by one
  const [visibleHoleCount, setVisibleHoleCount] = useState<0 | 1 | 2>(
    initialState.handState ? 2 : 2
  )
  const [dealtSeatNumbers, setDealtSeatNumbers] = useState<Set<number>>(() => {
    const s = new Set<number>()
    initialState.handState?.players.forEach(p => s.add(p.seatNumber))
    return s
  })
  const [visibleCommunityCount, setVisibleCommunityCount] = useState(
    initialState.handState?.communityCards.length ?? 0
  )

  const nextHandTimerRef   = useRef<ReturnType<typeof setInterval> | null>(null)
  const socketRef          = useRef<AppSocket | null>(null)
  const prevShowdownRef    = useRef<ShowdownPayload | null>(null)
  const sessionRef         = useRef<SessionInfo | null>(null)
  const mutedRef           = useRef(false)
  const heroCardTimersRef  = useRef<ReturnType<typeof setTimeout>[]>([])
  const seatAnimTimersRef  = useRef<ReturnType<typeof setTimeout>[]>([])
  const communityTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const currentHandRef     = useRef<PublicHandState | null>(initialState.handState)
  const visibleCommunityCountRef = useRef(initialState.handState?.communityCards.length ?? 0)
  const prevHandNumberRef  = useRef<number | null>(initialState.handState?.handNumber ?? null)
  const chatOpenRef        = useRef(false)
  const chatScrollRef      = useRef<HTMLDivElement | null>(null)
  // Tracks whether the current user was seated on the last table_state — used to detect
  // the seated→spectating transition so outOfChipsMsg only fires on a real demotion.
  const prevSeatedRef      = useRef(myStatus === 'seated')
  const hasHandEverStartedRef = useRef(initialState.handState !== null)

  // ── Derived values ──────────────────────────────────────────────────────────
  mutedRef.current = muted
  chatOpenRef.current = chatOpen

  // DEV-ONLY layout preview override — see buildLayoutPreview() above. A no-op
  // unless LAYOUT_PREVIEW_ENABLED is manually flipped to true in a dev build.
  const layoutPreviewActive = process.env.NODE_ENV !== 'production' && LAYOUT_PREVIEW_ENABLED
  const layoutPreview = layoutPreviewActive ? buildLayoutPreview(LAYOUT_PREVIEW_SEAT_COUNT, currentUserId) : null

  const hand: PublicHandState | null = layoutPreview ? layoutPreview.hand : state.handState
  const max    = layoutPreview ? LAYOUT_PREVIEW_SEAT_COUNT : state.maxPlayers
  // Derive anchor from live seat state so the current player is always at visual
  // seat 1 (bottom-center), even if the mySeatNumber prop is stale or was null.
  const heroSeatNumber = layoutPreview ? null : state.seats.find(s => s.playerId === currentUserId)?.seatNumber
  const anchor = layoutPreview ? 1 : (heroSeatNumber ?? mySeatNumber ?? 1)
  const effectiveHoleCards = layoutPreview ? layoutPreview.myHoleCards : myHoleCards
  const effectiveDealtSeats = layoutPreview ? new Set(layoutPreview.seats.map(s => s.seatNumber)) : dealtSeatNumbers

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
  const canLeave   = !sessionActive || isAdmin || state.tableType === 'open'
  const canStart   = myCurrentStatus === 'seated' && !hand && seatedCnt >= 2 && nextHandIn === null && !sessionExpired && !hasHandEverStartedRef.current

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
    const tick = () => {
      const tl = Math.max(0, Math.ceil((turnTimerInfo.endsAt - Date.now()) / 1000))
      setTimeLeft(tl)
      if (tl > 0 && tl <= 10 && !mutedRef.current) soundManager.play('timer_warning')
    }
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

  // Fullscreen change listener
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // ── Chip flight animations (visual only — never touches game state) ────────
  const [chipFlights, setChipFlights] = useState<ChipFlightData[]>([])
  const [potPulse, setPotPulse] = useState(false)
  const chipFlightIdRef = useRef(0)
  const prevRoundContribRef = useRef<Map<number, number>>(new Map())
  const prevContribHandNumberRef = useRef<number | null>(null)
  const prevPhaseRef = useRef<PublicHandState['phase'] | null>(null)
  const prevShowdownFlightHandRef = useRef<number | null>(null)

  // The static bet-pile chip stacks render from this map, not straight from
  // hp.roundContribution — roundContribution still drives every value here, but a seat's
  // pile is only deleted once its collect-to-pot flight has visually landed, so it can't
  // pop out of existence the instant the server resets roundContribution to 0 for a new
  // street (see collectBetPilesToPot below).
  const [visiblePiles, setVisiblePiles] = useState<Map<number, number>>(new Map())

  const removeChipFlight = (id: string) => setChipFlights(prev => prev.filter(f => f.id !== id))

  const pulsePot = (delay: number) => {
    setTimeout(() => {
      setPotPulse(true)
      setTimeout(() => setPotPulse(false), 260)
    }, delay)
  }

  // Sweep every seat's visible bet pile (captured in prevRoundContribRef) into the
  // center pot — fired once when a betting round ends (street change or hand end).
  // The static piles keep rendering (from visiblePiles) until the flight lands, then
  // get removed — so a street change always reads as "piles fly into the pot," never
  // as "piles vanish, then a flight plays."
  const collectBetPilesToPot = () => {
    const collectFlights: ChipFlightData[] = []
    const seatsToClear: Array<[seatNumber: number, amt: number]> = []
    for (const [seatNumber, amt] of prevRoundContribRef.current) {
      if (amt <= 0) continue
      const vs = toVisual(seatNumber, anchor, max)
      collectFlights.push({
        id: `pf${chipFlightIdRef.current++}`,
        from: chipPosAnchor(vs, max),
        to: POT_CENTER_POS,
        amount: amt,
        duration: COLLECT_CHIP_FLIGHT_MS,
      })
      seatsToClear.push([seatNumber, amt])
    }
    if (collectFlights.length > 0) {
      setChipFlights(prev => [...prev, ...collectFlights])
      pulsePot(COLLECT_CHIP_FLIGHT_MS)
      setTimeout(() => {
        setVisiblePiles(prev => {
          const next = new Map(prev)
          // Only clear a seat if its pile still holds the amount we collected — a fast
          // pre-action on the next street may already have set a fresh value for the
          // same seat number, which must not get wiped out by this stale collection.
          for (const [s, amt] of seatsToClear) {
            if (next.get(s) === amt) next.delete(s)
          }
          return next
        })
      }, COLLECT_CHIP_FLIGHT_MS)
    }
  }

  // Blinds / bet / call / raise / all-in land in front of the player's own seat (a small
  // bet pile) rather than the pot — detected as a rise in a seat's roundContribution, which
  // uniformly covers every chip-producing action (blinds are just the first contribution of
  // a fresh hand). Those piles only sweep into the pot once the betting round ends.
  useEffect(() => {
    if (layoutPreview) return

    if (!hand) {
      // Hand over — collect whatever was still sitting in front of players (the final
      // street's bets) before the showdown pot→winner flight runs.
      if (prevContribHandNumberRef.current !== null) {
        collectBetPilesToPot()
      }
      prevRoundContribRef.current.clear()
      prevContribHandNumberRef.current = null
      prevPhaseRef.current = null
      return
    }

    if (prevContribHandNumberRef.current !== hand.handNumber) {
      // Fresh hand — nothing left over to collect (the previous hand's end already did it).
      prevRoundContribRef.current.clear()
      setVisiblePiles(new Map())
      prevContribHandNumberRef.current = hand.handNumber
      prevPhaseRef.current = hand.phase
    } else if (prevPhaseRef.current !== hand.phase) {
      // Street advanced within the same hand — sweep last street's bet piles into the pot.
      collectBetPilesToPot()
      prevRoundContribRef.current.clear()
      prevPhaseRef.current = hand.phase
    }

    const newFlights: ChipFlightData[] = []
    const pileUpdates: Array<[number, number]> = []
    for (const p of hand.players) {
      const prevAmt = prevRoundContribRef.current.get(p.seatNumber) ?? 0
      const delta = p.roundContribution - prevAmt
      if (delta > 0) {
        const vs = toVisual(p.seatNumber, anchor, max)
        newFlights.push({
          id: `cf${chipFlightIdRef.current++}`,
          from: seatAnchorPos(vs, max),
          to: chipPosAnchor(vs, max),
          amount: delta,
          duration: ACTION_CHIP_FLIGHT_MS,
        })
        pileUpdates.push([p.seatNumber, p.roundContribution])
      }
      prevRoundContribRef.current.set(p.seatNumber, p.roundContribution)
    }
    if (pileUpdates.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisiblePiles(prev => {
        const next = new Map(prev)
        for (const [seat, amt] of pileUpdates) next.set(seat, amt)
        return next
      })
    }
    if (newFlights.length === 0) return
    setChipFlights(prev => [...prev, ...newFlights])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand, anchor, max, layoutPreview])

  // Pot → winner seat(s) when a hand ends. Held back by WINNER_FLIGHT_DELAY_MS so the
  // winner/loser cards get a clear dwell on screen before the pot moves — otherwise the
  // chips would fly the instant showdown_result lands, before anyone can read the hands.
  // anchor/max are captured at schedule time (not re-read via the dependency array) so a
  // resize mid-dwell can't cancel-and-skip the still-pending flight for this hand.
  useEffect(() => {
    if (layoutPreview) return
    if (!showdownResult) return
    if (prevShowdownFlightHandRef.current === showdownResult.handNumber) return
    prevShowdownFlightHandRef.current = showdownResult.handNumber

    const sd = showdownResult
    const a = anchor
    const m = max
    const timer = setTimeout(() => {
      const newFlights: ChipFlightData[] = []
      for (const pot of sd.pots) {
        if (pot.winners.length === 0) continue
        const share = Math.floor(pot.amount / pot.winners.length)
        for (const winnerId of pot.winners) {
          const seatNumber = sd.players.find(pl => pl.playerId === winnerId)?.seatNumber
          if (seatNumber == null) continue
          const vs = toVisual(seatNumber, a, m)
          newFlights.push({
            id: `wf${chipFlightIdRef.current++}`,
            from: POT_CENTER_POS,
            to: seatAnchorPos(vs, m),
            amount: share,
            duration: WINNER_CHIP_FLIGHT_MS,
          })
        }
      }
      if (newFlights.length > 0) setChipFlights(prev => [...prev, ...newFlights])
    }, WINNER_FLIGHT_DELAY_MS)

    return () => clearTimeout(timer)
    // anchor/max intentionally excluded — see comment above the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showdownResult, layoutPreview])

  // Auto-scroll chat to the latest message
  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight
  }, [chatMessages, chatOpen])

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
        currentHandRef.current = p.handState
        setState(p)
        if (!p.handState) {
          setTurnTimerInfo(null)
          setDealtSeatNumbers(new Set())
          visibleCommunityCountRef.current = 0
          setVisibleCommunityCount(0)
        }

        // Detect demotion to spectating due to zero chips — only fire the message
        // on the transition from seated to spectating, never for players who were
        // already spectating when they loaded (or on repeated table_state events).
        const nowSpectating = p.spectators.some(s => s.playerId === currentUserId)
        const nowSeated = p.seats.some(s => s.playerId === currentUserId)
        if (nowSeated) {
          prevSeatedRef.current = true
        } else if (nowSpectating) {
          if (prevSeatedRef.current) {
            setOutOfChipsMsg(true)
          }
          prevSeatedRef.current = false
          setMyCurrentStatus('spectating')
        }

        // Animate opponent card backs when a new hand starts
        if (p.handState) {
          // Detect new hand by handNumber; reset seat animation so every deal animates
          if (p.handState.handNumber !== prevHandNumberRef.current) {
            prevHandNumberRef.current = p.handState.handNumber
            seatAnimTimersRef.current.forEach(clearTimeout); seatAnimTimersRef.current = []
            setDealtSeatNumbers(new Set())
          }

          const opponentSeats = p.handState.players
            .filter(pl => pl.playerId !== currentUserId)
            .map(pl => pl.seatNumber)
          setDealtSeatNumbers(prev => {
            const toAdd = opponentSeats.filter(n => !prev.has(n))
            if (toAdd.length === 0) return prev
            toAdd.forEach((seatNum, i) => {
              seatAnimTimersRef.current.push(setTimeout(() => {
                if (!active) return
                setDealtSeatNumbers(prevS => { const ns = new Set(prevS); ns.add(seatNum); return ns })
                if (!mutedRef.current) soundManager.play('card_deal')
              }, 200 + i * 200))
            })
            return prev
          })

          // Animate community cards when new ones arrive
          const newCount = p.handState.communityCards.length
          const prevCount = visibleCommunityCountRef.current
          if (newCount > prevCount) {
            communityTimersRef.current.forEach(clearTimeout)
            communityTimersRef.current = []
            for (let i = prevCount; i < newCount; i++) {
              const targetCount = i + 1
              communityTimersRef.current.push(setTimeout(() => {
                if (!active) return
                visibleCommunityCountRef.current = targetCount
                setVisibleCommunityCount(targetCount)
                if (!mutedRef.current) soundManager.play('card_deal')
              }, (i - prevCount) * 280))
            }
          }
        }
      }

      const onDealCards = (p: { tableId: string; holeCards: [Card, Card] }) => {
        if (!active || p.tableId !== initialState.tableId) return
        hasHandEverStartedRef.current = true
        // Save previous showdown before clearing
        if (prevShowdownRef.current) setPrevHandResult(prevShowdownRef.current)
        prevShowdownRef.current = null
        setMyHoleCards(p.holeCards)
        setShowdownResult(null)
        setWinnerToastVisible(false)
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

        // Reset animation state — onTableState handles scheduling opponent seat timers
        heroCardTimersRef.current.forEach(clearTimeout); heroCardTimersRef.current = []
        seatAnimTimersRef.current.forEach(clearTimeout); seatAnimTimersRef.current = []
        communityTimersRef.current.forEach(clearTimeout); communityTimersRef.current = []
        setVisibleHoleCount(0)
        setDealtSeatNumbers(new Set())
        visibleCommunityCountRef.current = 0
        setVisibleCommunityCount(0)

        // Animate hero hole cards one by one
        heroCardTimersRef.current.push(setTimeout(() => {
          if (!active) return
          setVisibleHoleCount(1)
          if (!mutedRef.current) soundManager.play('card_deal')
        }, 120))
        heroCardTimersRef.current.push(setTimeout(() => {
          if (!active) return
          setVisibleHoleCount(2)
          if (!mutedRef.current) soundManager.play('card_deal')
        }, 350))
      }

      const onShowdownResult = (p: ShowdownPayload) => {
        if (!active || p.tableId !== initialState.tableId) return
        prevShowdownRef.current = p
        setShowdownResult(p)
        setRunoutRevealedCards({})
        setTurnTimerInfo(null)
        setPreAction(null)
        setWinnerToastVisible(true)
        setTimeout(() => { if (active) setWinnerToastVisible(false) }, 4500)
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
        if (p.playerId !== currentUserId && !mutedRef.current) {
          const sndMap: Partial<Record<BettingAction, SoundName>> = {
            FOLD: 'fold', CHECK: 'check', CALL: 'call', RAISE: 'raise', ALL_IN: 'all_in',
          }
          const snd = sndMap[p.action]
          if (snd) soundManager.play(snd)
        }
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

      const onKickedFromTable = (p: { tableId: string; reason: 'out_of_chips' | 'admin_kicked' }) => {
        if (!active || p.tableId !== initialState.tableId) return
        const msg = p.reason === 'out_of_chips'
          ? 'Hard luck! You ran out of chips.'
          : 'You were removed by an admin.'
        setKickedMsg({ msg, reason: p.reason })
        setTimeout(() => { if (active) router.push(isAdmin ? '/admin/dashboard' : '/lobby') }, 2500)
      }

      const onChatMessage = (p: ChatMessage) => {
        if (!active || p.tableId !== initialState.tableId) return
        setChatMessages(prev => {
          const next = [...prev, p]
          return next.length > CHAT_HISTORY_LIMIT ? next.slice(next.length - CHAT_HISTORY_LIMIT) : next
        })
        if (!chatOpenRef.current) setUnreadChatCount(c => c + 1)
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
      socket.on('table_chat_message', onChatMessage)

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
        socket.off('table_chat_message', onChatMessage)
        if (nextHandTimerRef.current) { clearInterval(nextHandTimerRef.current); nextHandTimerRef.current = null }
        heroCardTimersRef.current.forEach(clearTimeout); heroCardTimersRef.current = []
        seatAnimTimersRef.current.forEach(clearTimeout); seatAnimTimersRef.current = []
        communityTimersRef.current.forEach(clearTimeout); communityTimersRef.current = []
      }
    })

    return () => { active = false; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialState.tableId, myStatus])

  // ── Handlers ────────────────────────────────────────────────────────────────

  function handleLeave() {
    setLeaving(true)
    const exitRoute = isAdmin ? '/admin/dashboard' : '/lobby'
    const s = socketRef.current
    if (!s) { router.push(exitRoute); return }
    const onLeft = ({ tableId }: { tableId: string }) => {
      if (tableId !== initialState.tableId) return
      s.off('table_left', onLeft)
      router.push(exitRoute)
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
    soundManager.unlock() // warm up AudioContext on first gesture
    if (!mutedRef.current) {
      const sndMap: Partial<Record<BettingAction, SoundName>> = {
        FOLD: 'fold', CHECK: 'check', CALL: 'call', RAISE: 'raise', ALL_IN: 'all_in',
      }
      const snd = sndMap[action]
      if (snd) soundManager.play(snd)
    }
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

  function toggleChat() {
    setChatOpen(o => {
      const next = !o
      if (next) setUnreadChatCount(0)
      return next
    })
  }

  function sendChatMessage() {
    const trimmed = chatInput.trim()
    if (trimmed.length === 0 || trimmed.length > CHAT_MAX_LEN) return
    socketRef.current?.emit('table_chat_send', { tableId: initialState.tableId, message: trimmed })
    setChatInput('')
  }

  function handleFullscreen() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    if (isIOS) {
      // Toggle theater mode immediately for a visual improvement
      setTheaterMode(m => !m)
      // If already installed as a PWA (standalone), no need to show install tip
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches
      if (!isStandalone && !theaterMode) {
        setShowIosInstructions(true)
      }
      return
    }

    const doc = document as Document & {
      webkitFullscreenElement?: Element
      webkitExitFullscreen?: () => void
    }
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => void
    }
    const supported = !!(el.requestFullscreen || el.webkitRequestFullscreen)
    if (!supported) {
      // Fallback to theater mode on any unsupported browser
      setTheaterMode(m => !m)
      return
    }
    if (!document.fullscreenElement && !doc.webkitFullscreenElement) {
      let req: Promise<void>
      if (el.requestFullscreen) {
        req = el.requestFullscreen()
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen()
        req = Promise.resolve()
      } else {
        req = Promise.resolve()
      }
      req.catch(() => setTheaterMode(m => !m))
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {})
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen()
      }
    }
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
  const needsMyAction = myCurrentStatus === 'seated' && isMyTurn && myHP?.playerPhase === 'active' && preAction === null
  // Whether the bottom panel is showing only the pre-action buttons (no status text below) —
  // used to shrink the panel so it doesn't waste vertical space while waiting.
  const preActionOnly = myStatus === 'seated' && !!hand && !isMyTurn && myHP?.playerPhase === 'active'

  return (
    <div className={`flex flex-col overflow-hidden${theaterMode ? ' tbl-theater' : ''}`} style={{
      background: '#060b15',
      height: '100dvh',
      minHeight: '100dvh',
      // env(safe-area-inset-top) is non-zero in iOS standalone (black-translucent status bar)
      paddingTop: 'env(safe-area-inset-top)',
      paddingLeft: 'env(safe-area-inset-left)',
      paddingRight: 'env(safe-area-inset-right)',
      // Bottom safe area is handled by the action panel itself so its background
      // extends to the screen edge while its content stays above the home indicator
    }}>

      {/* ── Portrait lock ───────────────────────────────────────────────────── */}
      <div className="portrait-lock" aria-hidden="true">
        <div style={{ fontSize: 56, lineHeight: 1, userSelect: 'none', animation: 'portrait-rock 1.4s ease-in-out infinite' }}>📱</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ color: '#f1f5f9', fontWeight: 700, fontSize: 18, letterSpacing: '-0.3px', margin: 0 }}>
            Rotate your phone to landscape to play
          </p>
          <p style={{ color: '#475569', fontSize: 13, lineHeight: 1.4, margin: 0 }}>
            This game requires landscape orientation
          </p>
        </div>
        <div style={{ display: 'flex', gap: 5, opacity: 0.2, marginTop: 4 }}>
          {[0,1,2,3,4].map(i => (
            <div key={i} style={{ width: 20, height: 28, borderRadius: 3, background: 'rgba(201,168,76,0.8)', border: '1px solid rgba(201,168,76,0.4)' }} />
          ))}
        </div>
      </div>

      {/* ── iOS "Add to Home Screen" instructions modal ─────────────────────── */}
      {showIosInstructions && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px env(safe-area-inset-left, 20px)',
          }}
          onClick={() => setShowIosInstructions(false)}
        >
          <div
            style={{
              background: 'linear-gradient(145deg,#0e1c30,#0a1520)',
              border: '1px solid rgba(201,168,76,0.35)',
              borderRadius: 16, padding: '20px 22px',
              maxWidth: 320, width: '100%',
              boxShadow: '0 16px 48px rgba(0,0,0,0.8), 0 0 0 1px rgba(201,168,76,0.08)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ color: '#fde68a', fontWeight: 800, fontSize: 15 }}>Full Screen on iPhone</span>
              <button
                onClick={() => setShowIosInstructions(false)}
                style={{ background: 'none', border: 'none', color: '#475569', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
              >✕</button>
            </div>

            <p style={{ color: '#94a3b8', fontSize: 12, marginBottom: 16, lineHeight: 1.6, margin: '0 0 16px' }}>
              iPhone Safari doesn&apos;t support true fullscreen for websites.
              For a native app experience, add Poker to your Home Screen:
            </p>

            {/* Steps */}
            {[
              { icon: '⬆️', step: 'Tap the Share button', sub: 'at the bottom of Safari' },
              { icon: '➕', step: 'Tap "Add to Home Screen"', sub: 'scroll down if you don\'t see it' },
              { icon: '🃏', step: 'Open Poker from your Home Screen', sub: 'it will launch in full screen' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 12 }}>
                <span style={{ fontSize: 22, flexShrink: 0, lineHeight: 1, marginTop: 1 }}>{s.icon}</span>
                <div>
                  <div style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}>{s.step}</div>
                  <div style={{ color: '#475569', fontSize: 11, marginTop: 2 }}>{s.sub}</div>
                </div>
              </div>
            ))}

            {/* Theater mode note */}
            <div style={{
              marginTop: 16, padding: '8px 12px',
              background: 'rgba(201,168,76,0.07)', border: '1px solid rgba(201,168,76,0.2)',
              borderRadius: 8,
            }}>
              <p style={{ color: '#fbbf24', fontSize: 11, margin: 0, lineHeight: 1.5 }}>
                ✓ Theater mode is active — the header is now hidden to maximise screen space.
              </p>
            </div>

            <button
              onClick={() => setShowIosInstructions(false)}
              style={{
                marginTop: 14, width: '100%',
                background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)',
                borderRadius: 8, padding: '10px 0',
                color: '#e8c97a', fontWeight: 700, fontSize: 13, cursor: 'pointer',
                letterSpacing: '0.3px',
              }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ── Kicked / out-of-chips overlay ───────────────────────────────────── */}
      {kickedMsg && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: kickedMsg.reason === 'out_of_chips' ? '#1c1000' : '#1a0a0a',
            border: `1px solid ${kickedMsg.reason === 'out_of_chips' ? '#d97706' : '#b91c1c'}`,
            borderRadius: 12, padding: '24px 32px', textAlign: 'center',
            boxShadow: '0 8px 40px rgba(0,0,0,0.8)',
          }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>
              {kickedMsg.reason === 'out_of_chips' ? '💸' : '🚫'}
            </div>
            <div style={{
              color: kickedMsg.reason === 'out_of_chips' ? '#fde68a' : '#fca5a5',
              fontWeight: 700, fontSize: 15, marginBottom: 6,
            }}>
              {kickedMsg.msg}
            </div>
            <div style={{ color: '#6b7280', fontSize: 12 }}>Redirecting to lobby…</div>
          </div>
        </div>
      )}

      {/* ── Out of chips toast ─────────────────────────────────────────────── */}
      {outOfChipsMsg && (
        <div style={{
          position: 'fixed', top: 52, left: '50%', transform: 'translateX(-50%)',
          zIndex: 500, background: '#1c0f00', border: '1px solid rgba(234,179,8,0.4)',
          borderRadius: 8, padding: '8px 16px',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <span style={{ color: '#fde68a', fontSize: 13, fontWeight: 600 }}>
            ⚠️ You ran out of chips and moved to spectator mode.
          </span>
          <button onClick={() => setOutOfChipsMsg(false)} style={{ background: 'transparent', border: 'none', color: '#fde68a', fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>✕</button>
        </div>
      )}

      {/* ── Winner toast — compact pill, auto-hides after 4.5s ─────────────── */}
      {winnerToastVisible && showdownResult && (
        <WinnerToast showdown={showdownResult} onDismiss={() => setWinnerToastVisible(false)} />
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
      <header className="tbl-header" style={{
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
          {(showdownResult || prevHandResult) && (
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
              {showdownResult ? 'Results' : 'Last Hand'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <span className="tbl-hide-mobile" style={{ color: '#475569', fontSize: 12 }}>{state.smallBlind}/{state.bigBlind}</span>
          {myCurrentStatus === 'seated' && mySeatNumber != null && (
            <span className="tbl-hide-mobile" style={{ color: '#475569', fontSize: 12 }}>
              Seat <span style={{ color: '#cbd5e1' }}>{mySeatNumber}</span>
            </span>
          )}
          {/* Session badge */}
          {sessionInfo && (
            sessionExpired ? (
              <span className="tbl-hide-mobile" style={{ background: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 5, padding: '2px 8px', color: '#6ee7b7', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>
                Session ended — free to leave
              </span>
            ) : (
              <span className="tbl-hide-mobile" title="Session time remaining" style={{
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
            onClick={toggleChat}
            title={chatOpen ? 'Hide chat' : 'Show chat'}
            style={{
              position: 'relative',
              background: chatOpen ? 'rgba(201,168,76,0.18)' : 'transparent',
              border: `1px solid ${chatOpen ? 'rgba(201,168,76,0.45)' : 'rgba(255,255,255,0.1)'}`,
              borderRadius: 5, padding: '2px 8px', color: chatOpen ? '#e8c97a' : '#6b7280',
              fontSize: 13, cursor: 'pointer',
            }}
          >
            💬
            {unreadChatCount > 0 && !chatOpen && (
              <span style={{
                position: 'absolute', top: -5, right: -5,
                background: '#dc2626', color: 'white', fontSize: 9, fontWeight: 700,
                borderRadius: 8, minWidth: 14, height: 14, padding: '0 3px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
              }}>
                {unreadChatCount > 9 ? '9+' : unreadChatCount}
              </span>
            )}
          </button>
          <button
            onClick={() => { setMuted(m => !m); soundManager.unlock() }}
            title={muted ? 'Unmute sounds' : 'Mute sounds'}
            style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, padding: '2px 8px', color: '#6b7280', fontSize: 13, cursor: 'pointer' }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
          {/* Fullscreen / theater mode toggle */}
          <button
            onClick={handleFullscreen}
            title={(isFullscreen || theaterMode) ? 'Exit Fullscreen' : 'Fullscreen'}
            style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, padding: '2px 7px', color: '#6b7280', fontSize: 12, cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {(isFullscreen || theaterMode) ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3"/>
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M8 3H5a2 2 0 00-2 2v3M21 8V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3M16 21h3a2 2 0 002-2v-3"/>
              </svg>
            )}
          </button>
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

      {/* ── Hand result / previous hand history panel ──────────────────────── */}
      {showPrevHand && (showdownResult || prevHandResult) && (
        showdownResult ? (
          /* Current showdown: full ShowdownBanner in a floating side panel */
          <div className="tbl-result-panel" style={{ position: 'fixed', top: 52, right: 12, zIndex: 600, pointerEvents: 'auto' }}>
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setShowPrevHand(false)}
                style={{
                  position: 'absolute', top: 10, right: 12, zIndex: 10,
                  background: 'transparent', border: 'none', color: '#475569',
                  fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: 0,
                }}
              >✕</button>
              <ShowdownBanner
                key={showdownResult.handNumber}
                showdown={showdownResult}
                currentUserId={currentUserId}
                myHoleCards={myHoleCards}
                onShow={handleShowCards}
                revealedCards={revealedCards}
              />
            </div>
          </div>
        ) : prevHandResult ? (
          /* Previous hand: compact summary panel */
          <div className="tbl-result-panel" style={{
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
                <span style={{ color: '#e8c97a', fontWeight: 700 }}>{formatNumber(prevHandResult.pots[0].amount)}</span>
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
                    {p.netChipChange > 0 ? '+' : ''}{formatNumber(p.netChipChange)}
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
        ) : null
      )}

      {/* ── Table chat — fixed floating panel, collapsible via header button.
          Anchored on the LEFT: the right side is already claimed by the
          "previous hand" panel (zIndex 600) and the dealer tip modal
          (zIndex 900), both of which would otherwise sit on top of chat
          and swallow its clicks. ──────────────────────────────────────── */}
      {chatOpen && (
        <div className="tbl-chat-panel" style={{
          position: 'fixed', top: 52, left: 12, bottom: 100, zIndex: 550,
          width: 260, display: 'flex', flexDirection: 'column',
          background: 'linear-gradient(145deg, #0d1929, #080f1d)',
          border: '1px solid rgba(201,168,76,0.28)',
          borderRadius: 10,
          boxShadow: '0 8px 30px rgba(0,0,0,0.75)',
          overflow: 'hidden',
          pointerEvents: 'auto',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
          }}>
            <span style={{ color: '#fde68a', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Table Chat
            </span>
            <button onClick={toggleChat}
              style={{ background: 'transparent', border: 'none', color: '#475569', fontSize: 15, cursor: 'pointer', lineHeight: 1, padding: 0 }}>✕</button>
          </div>
          <div ref={chatScrollRef} className="tbl-chat-messages" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chatMessages.length === 0 ? (
              <span style={{ color: '#475569', fontSize: 11, fontStyle: 'italic' }}>No messages yet — say hi!</span>
            ) : (
              chatMessages.map((m, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{
                      color: m.playerId === currentUserId ? '#93c5fd' : '#e8c97a', fontWeight: 700, fontSize: 10.5,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
                    }}>
                      {m.playerId === currentUserId ? 'You' : m.username}
                    </span>
                    <span style={{ color: '#475569', fontSize: 9 }}>
                      {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <span style={{ color: '#cbd5e1', fontSize: 11.5, wordBreak: 'break-word', lineHeight: 1.3 }}>{m.message}</span>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
            <input
              type="text"
              value={chatInput}
              onChange={e => setChatInput(e.target.value.slice(0, CHAT_MAX_LEN))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); sendChatMessage() } }}
              placeholder="Type a message…"
              maxLength={CHAT_MAX_LEN}
              style={{
                flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 6, padding: '5px 8px', color: '#e2e8f0', fontSize: 11.5, outline: 'none',
              }}
            />
            <button
              onClick={sendChatMessage}
              disabled={chatInput.trim().length === 0 || chatInput.trim().length > CHAT_MAX_LEN}
              style={{
                background: chatInput.trim().length === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(201,168,76,0.18)',
                border: '1px solid rgba(201,168,76,0.35)', borderRadius: 6, padding: '5px 10px',
                color: chatInput.trim().length === 0 ? '#475569' : '#e8c97a', fontSize: 11, fontWeight: 700,
                cursor: chatInput.trim().length === 0 ? 'not-allowed' : 'pointer', flexShrink: 0,
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════ TABLE AREA + ACTION PANEL ══ */}
      <div className="tbl-flex-area" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>

        {/* ═══════════════════════════════════════════════ TABLE ════════ */}
        {/* Table wrap: absolutely fills its flex slot so tbl-table-inner can use max-height: 100% */}
        <div className="tbl-table-wrap" style={{
          flex: 1, minHeight: 0,
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div className="tbl-table-maxw" style={{
            position: 'absolute',
            inset: '10px 24px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {/* aspect-ratio + max-height: 100% keeps the oval inside available space on every screen size */}
            <div className="tbl-table-inner" data-seatcount={max} style={{
              width: '100%',
              maxWidth: 770,
              aspectRatio: '1.72',
              maxHeight: '100%',
              position: 'relative',
              // Consumed by mobile-landscape seat/chip CSS to scale pod density down as
              // the table gets fuller (so a 9-max table still fits a phone screen).
              ...({ '--mscale': mobileDensityScale(max) } as React.CSSProperties),
            }}>

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
                position: 'absolute', top: 0, left: 0, right: 0, bottom: '8%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'none',
              }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>

                  {nextHandIn != null && !hand && !showdownResult && <ShuffleAnimation />}

                  {hand && (
                    <>
                      <div className="tbl-pot-pill" style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        background: 'rgba(0,0,0,0.72)', border: '1px solid rgba(201,168,76,0.3)',
                        borderRadius: 14, padding: '3px 12px',
                        backdropFilter: 'blur(6px)',
                        transform: 'translateY(16px)',
                        animation: potPulse ? 'pot-pulse 0.3s ease-out' : 'none',
                      }}>
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: 'rgba(245,236,215,0.45)' }}>
                          POT
                        </span>
                        {hand.pot > 0 && <MiniChip amount={hand.pot} size={13} />}
                        <div className="tbl-pot-amount" style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12, fontWeight: 600, color: '#e8c97a', letterSpacing: '-0.5px' }}>
                          {formatNumber(hand.pot)}
                        </div>
                      </div>

                      <div className="tbl-community-row" style={{ display: 'flex', gap: 6 }}>
                        {hand.communityCards.slice(0, visibleCommunityCount).map((c, i) => (
                          <div key={`card-${i}`} style={{ animation: 'card-deal-in 0.28s ease-out' }}>
                            <PlayingCard c={c} size="community" />
                          </div>
                        ))}
                        {Array.from({ length: 5 - visibleCommunityCount }).map((_, i) => (
                          <div key={`empty-${visibleCommunityCount + i}`} style={{
                            width: CARD_DIMS.community.w, height: CARD_DIMS.community.h,
                            borderRadius: CARD_DIMS.community.r,
                            border: '1.5px dashed rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)',
                            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.04)',
                          }} />
                        ))}
                      </div>
                    </>
                  )}

                  {/* At showdown keep the board visible in the center — the compact
                      WinnerToast (top-centre) and "Results" side panel carry the detail. */}
                  {!hand && showdownResult && showdownResult.communityCards.length > 0 && (
                    <div className="tbl-community-row" style={{ display: 'flex', gap: 6 }}>
                      {showdownResult.communityCards.map((c, i) => (
                        <div key={i} style={{ lineHeight: 0 }}>
                          <PlayingCard c={c} size="community" />
                        </div>
                      ))}
                    </div>
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
              {(layoutPreview ? layoutPreview.seats : state.seats).map(seat => {
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
                // Buffered copy of roundContribution — see visiblePiles for why the static
                // pile can't read straight off hp.roundContribution. layoutPreview is a static
                // mock with no socket-driven effect to populate visiblePiles, so it reads direct.
                const betPile  = layoutPreview ? (hp?.roundContribution ?? 0) : (visiblePiles.get(seat.seatNumber) ?? 0)
                const sdFolded = !hand && sdP?.hasFolded === true
                const isWinner = !hand && !!showdownResult && !!seat.playerId &&
                  (showdownResult.pots[0]?.winners ?? []).includes(seat.playerId)
                const showTmr  = isTurn && turnTimerInfo?.playerId === seat.playerId && timeLeft > 0
                const lastAct  = seat.playerId ? lastActions[seat.playerId] : null
                const dimmed   = folded || sdFolded

                // Fixed mobile-landscape preset class — pins the pod by its
                // rail-side edge and orders its content (avatar/cards/pill)
                // so nothing overlaps or bleeds off a phone screen.
                const podClass = mobileAnchorClass(vs, max)

                return (
                  <div key={seat.seatNumber}>
                    {/* Chip bet stack — hero bet is shown in the pod, opponents use floating chipPos.
                        Driven by betPile (buffered), not hp directly, so it survives past hand-end
                        (hp becomes undefined) for as long as the final collect-to-pot flight runs. */}
                    {occ && betPile > 0 && vs !== 1 && (
                      <div className="tbl-bet-chip" style={{ ...chipPos(vs, max), ...mobileChipVars(vs, max), position: 'absolute', zIndex: 10, pointerEvents: 'none' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          {showBlindLabels && isSB && (
                            <span style={{ background: '#1d4ed8', color: 'white', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>SB</span>
                          )}
                          {showBlindLabels && isBB && (
                            <span style={{ background: '#6d28d9', color: 'white', fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.04em' }}>BB</span>
                          )}
                          <ChipStack amount={betPile} />
                        </div>
                      </div>
                    )}

                    {/* Seat pod */}
                    <div
  className={`tbl-seat-pod ${podClass} ${mobileAnchorClass(vs, max)}`}
  style={{
    ...seatPos(vs, max),
    ...mobileSeatVars(vs, max),
  }}
>
                      {!occ ? (
                        /* Empty seat */
                        <div className="tbl-empty-seat" style={{
                          width: 52, height: 52, borderRadius: '50%',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: '1px dashed rgba(255,255,255,0.12)',
                          color: 'rgba(255,255,255,0.18)', fontSize: 10, cursor: 'default',
                        }}>
                          #{seat.seatNumber}
                        </div>
                      ) : (() => {
                        /* Occupied seat — v3 side-cards design */
                        const isHero = vs === 1

                        // Cards shown beside player (non-hero) or above (hero)
                        const runoutCards = seat.playerId ? runoutRevealedCards[seat.playerId] : undefined
                        const shownCards  = seat.playerId ? revealedCards[seat.playerId] : undefined

                        const heroIsLive = isHero && hand !== null && !folded && isMe && effectiveHoleCards !== null
                        const heroCards: [Card, Card] | null = isHero
                          ? (heroIsLive
                              ? effectiveHoleCards
                              : (!hand && sdP?.holeCards)
                              ? (sdP.holeCards as [Card, Card])
                              : (!hand && shownCards)
                              ? shownCards
                              : null)
                          : null

                        // Opponent cards shrink to "xs" once 7+ seats are in play — the table
                        // gets a lot more crowded per seat at that point, on every screen size.
                        const oppCardSize: CardSize = max <= 6 ? 'sm' : 'xs'
                        // Revealed cards (all-in runout or showdown) get one size larger
                        // so they are clearly readable from the table view.
                        const revealedCardSize: CardSize = max <= 6 ? 'md' : 'sm'

                        const sideCardNode = !isHero ? (
                          hand && !folded && hp ? (
                            isMe && effectiveHoleCards ? (
                              <div className="tbl-opponent-cards" style={{ display: 'flex', gap: 2 }}>
                                <PlayingCard c={effectiveHoleCards[0]} size={oppCardSize} />
                                <PlayingCard c={effectiveHoleCards[1]} size={oppCardSize} />
                              </div>
                            ) : !isMe && runoutCards ? (
                              <div className="tbl-opponent-cards" style={{ display: 'flex', gap: 4 }}>
                                <PlayingCard c={runoutCards[0]} size={revealedCardSize} />
                                <PlayingCard c={runoutCards[1]} size={revealedCardSize} />
                              </div>
                            ) : !isMe && effectiveDealtSeats.has(seat.seatNumber) ? (
                              <div className="tbl-opponent-cards" style={{ display: 'flex', gap: 2, animation: 'card-deal-in 0.3s ease-out' }}>
                                <CardBack size={oppCardSize} />
                                <CardBack size={oppCardSize} />
                              </div>
                            ) : null
                          ) : (!hand && (sdP?.holeCards || shownCards) && !isMe) ? (
                            <div className="tbl-opponent-cards" style={{ display: 'flex', gap: 4 }}>
                              <PlayingCard c={(sdP?.holeCards ?? shownCards!)[0]} size={revealedCardSize} />
                              <PlayingCard c={(sdP?.holeCards ?? shownCards!)[1]} size={revealedCardSize} />
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
                        const stackDisplay = hp ? formatNumber(hp.stack) : sdP ? formatNumber(sdP.finalStack) : '—'

                        // Shared avatar circle
                        const avatarCircle = (
                          <div style={{ position: 'relative', flexShrink: 0 }}>
                            <div className={isHero ? 'tbl-player-circle-hero' : 'tbl-player-circle'} style={{
                              width: isHero ? 48 : 42, height: isHero ? 48 : 42,
                              borderRadius: '50%',
                              background: isMe
                                ? 'radial-gradient(circle at 38% 35%, #1e3a5f, #0f2040)'
                                : 'radial-gradient(circle at 38% 35%, #1e2a3a, #0f1824)',
                              border: isTurn
                                ? '2px solid #c9a84c'
                                : isWinner
                                ? '2px solid rgba(201,168,76,0.7)'
                                : isMe
                                ? '2px solid rgba(201,168,76,0.4)'
                                : '2px solid rgba(255,255,255,0.12)',
                              boxShadow: isTurn
                                ? '0 0 0 3px rgba(201,168,76,0.2),0 0 14px rgba(201,168,76,0.4)'
                                : isWinner
                                ? '0 0 12px rgba(201,168,76,0.3)'
                                : 'none',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: isHero ? 18 : 15, fontWeight: 700, lineHeight: 1,
                              color: isMe ? '#e8c97a' : '#64748b',
                              letterSpacing: '-0.5px',
                              opacity: dimmed ? 0.3 : 1, transition: 'opacity 0.2s',
                              overflow: 'hidden', position: 'relative',
                            }}>
                              <span style={{ position: 'relative', zIndex: 1 }}>
                                {(seat.username ?? '?').charAt(0).toUpperCase()}
                              </span>
                            </div>
                            {isD && (
                              <div style={{ position: 'absolute', bottom: -2, right: -3, zIndex: 5 }}>
                                <DealerButton />
                              </div>
                            )}
                          </div>
                        )

                        // Shared seat pill
                        const seatPill = (
                          <div className="tbl-seat-pill" style={{
                            background: 'rgba(54, 51, 51, 0.5)',
                            border: `1px solid ${isTurn ? 'rgba(201,168,76,0.35)' : 'rgba(255,255,255,0.07)'}`,
                            borderRadius: 8, padding: '3px 10px', textAlign: 'center', minWidth: 72,
                            backdropFilter: 'blur(4px)',
                            boxShadow: isTurn ? '0 0 10px rgba(201,168,76,0.15)' : 'none',
                            opacity: dimmed ? 0.45 : 1, transition: 'opacity 0.2s',
                            transform: 'translate(-10px, -3px)',
                          }}>
                            <div className="tbl-seat-pill-name" style={{ fontSize: 9, letterSpacing: '1.2px', textTransform: 'uppercase', color: isMe ? '#c9a84c' : 'rgba(245,236,215,0.5)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90 }}>
                              {displayName}
                            </div>
                            <div className="tbl-seat-pill-stack" style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 12, fontWeight: 600, color: '#e8c97a', letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                              <MiniChip amount={hp?.stack ?? sdP?.finalStack ?? 0} size={10} />
                              {stackDisplay}
                            </div>
                            {pillAction && (
                              <div className="tbl-seat-pill-action" style={{ fontSize: 8, letterSpacing: '0.8px', textTransform: 'uppercase', marginTop: 1, color: pillColor, fontWeight: 600 }}>
                                {pillAction}
                              </div>
                            )}
                          </div>
                        )

 if (isHero) {
  // Hero: clean bottom row
  // [ avatar + optional bet ]   [ hole cards ]   [ compact name / stack pill ]
  return (
    <div
      className="tbl-hero-row"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: '2px 8px',
        pointerEvents: 'none',
      }}
    >
      {/* Left: avatar circle only */}
      <div
        className="tbl-hero-avatar-col"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          flexShrink: 0,
        }}
      >
        {avatarCircle}
      </div>

      {/* Middle: bet chip (if any) stacked just above the hero hole cards */}
      <div
        className="tbl-hero-cards-col"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          flexShrink: 0,
        }}
      >
        {betPile > 0 && (
          <div
            className="tbl-hero-bet-stack"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1,
            }}
          >
            {showBlindLabels && isSB && (
              <span
                style={{
                  background: '#1d4ed8',
                  color: 'white',
                  fontSize: 8,
                  fontWeight: 800,
                  padding: '1px 5px',
                  borderRadius: 3,
                  letterSpacing: '0.04em',
                }}
              >
                SB
              </span>
            )}

            {showBlindLabels && isBB && (
              <span
                style={{
                  background: '#6d28d9',
                  color: 'white',
                  fontSize: 8,
                  fontWeight: 800,
                  padding: '1px 5px',
                  borderRadius: 3,
                  letterSpacing: '0.04em',
                }}
              >
                BB
              </span>
            )}

            <ChipStack amount={betPile} />
          </div>
        )}

        {heroCards && (!heroIsLive || visibleHoleCount >= 1) && (
          <div
            className="tbl-hero-cards"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              flexShrink: 0,
            }}
          >
            {(!heroIsLive || visibleHoleCount >= 1) && (
              <div
                key="hc1"
                style={{
                  borderRadius: CARD_DIMS.md.r + 2,
                  lineHeight: 0,
                  flexShrink: 0,
                  boxShadow: heroIsLive
                    ? '0 0 0 1.5px rgba(201,168,76,0.65), 0 4px 16px rgba(0,0,0,0.75)'
                    : '0 2px 10px rgba(0,0,0,0.6)',
                  animation: heroIsLive ? 'card-deal-in 0.25s ease-out' : undefined,
                }}
              >
                <PlayingCard c={heroCards[0]} size="md" />
              </div>
            )}

            {(!heroIsLive || visibleHoleCount >= 2) && (
              <div
                key="hc2"
                style={{
                  borderRadius: CARD_DIMS.md.r + 2,
                  lineHeight: 0,
                  flexShrink: 0,
                  boxShadow: heroIsLive
                    ? '0 0 0 1.5px rgba(201,168,76,0.65), 0 4px 16px rgba(0,0,0,0.75)'
                    : '0 2px 10px rgba(0,0,0,0.6)',
                  animation: heroIsLive ? 'card-deal-in 0.25s ease-out' : undefined,
                }}
              >
                <PlayingCard c={heroCards[1]} size="md" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: timer + compact player info */}
      <div
        className="tbl-hero-info-col"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: 4,
          flexShrink: 0,
        }}
      >
        {showTmr && (
          <div style={{ position: 'relative', width: 28, height: 28, flexShrink: 0 }}>
            <svg
              viewBox="0 0 44 44"
              fill="none"
              style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}
            >
              <circle cx="22" cy="22" r="19" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" fill="none" />
              <circle
                cx="22"
                cy="22"
                r="19"
                fill="none"
                stroke={timeLeft <= 10 ? '#ef4444' : timeLeft <= 20 ? '#f59e0b' : '#c9a84c'}
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeDasharray={`${Math.max(0, (timeLeft / TIMER_TOTAL) * 119.4).toFixed(1)} 119.4`}
              />
            </svg>

            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  fontFamily: '"JetBrains Mono",monospace',
                  fontSize: 9,
                  fontWeight: 700,
                  color: '#f59e0b',
                }}
              >
                {timeLeft}
              </span>
            </div>
          </div>
        )}

        <div
          className="tbl-seat-pill tbl-hero-pill"
          style={{
            background: 'rgba(41, 41, 41, 0.47)',
            border: `1px solid ${isTurn ? 'rgba(201,168,76,0.45)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 7,
            padding: '4px 9px',
            textAlign: 'center',
            minWidth: 92,
            backdropFilter: 'blur(4px)',
            boxShadow: isTurn
              ? '0 0 10px rgba(201,168,76,0.18)'
              : '0 3px 10px rgba(0,0,0,0.4)',
            opacity: dimmed ? 0.45 : 1,
            transition: 'opacity 0.2s',
          }}
        >
          <div
            className="tbl-seat-pill-name"
            style={{
              fontSize: 8,
              letterSpacing: '0.9px',
              textTransform: 'uppercase',
              color: '#c9a84c',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 90,
            }}
          >
            {displayName}
          </div>

          <div
            className="tbl-seat-pill-stack"
            style={{
              fontFamily: '"JetBrains Mono",monospace',
              fontSize: 11,
              fontWeight: 700,
              color: '#e8c97a',
              letterSpacing: '-0.3px',
              lineHeight: 1.25,
            }}
          >
            {stackDisplay}
          </div>

          {pillAction && (
            <div
              className="tbl-seat-pill-action"
              style={{
                fontSize: 7,
                letterSpacing: '0.7px',
                textTransform: 'uppercase',
                marginTop: 1,
                color: pillColor,
                fontWeight: 700,
              }}
            >
              {pillAction}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

                        return (
                          <div className="tbl-opponent-seat" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                            {avatarCircle}
                            {sideCardNode}
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                              {showTmr && (
                                <div
  style={{
    position: 'relative',
    width: 24,
    height: 24,
    flexShrink: 0,
  }}
>
                                  <svg viewBox="0 0 44 44" fill="none" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                                    <circle cx="22" cy="22" r="19" stroke="rgba(255,255,255,0.08)" strokeWidth="3.5" fill="none" />
                                    <circle cx="22" cy="22" r="19" fill="none"
                                      stroke={timeLeft <= 10 ? '#ef4444' : timeLeft <= 20 ? '#f59e0b' : '#c9a84c'}
                                      strokeWidth="3.5" strokeLinecap="round"
                                      strokeDasharray={`${Math.max(0, (timeLeft / TIMER_TOTAL) * 119.4).toFixed(1)} 119.4`}
                                    />
                                  </svg>
                                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ fontFamily: '"JetBrains Mono",monospace', fontSize: 8, fontWeight: 700, color: '#f59e0b' }}>{timeLeft}</span>
                                  </div>
                                </div>
                              )}
                              {seatPill}
                            </div>
                          </div>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}

              {/* Chip flight overlay — purely visual, sits above seat pods and bet stacks */}
              {chipFlights.map(f => (
                <ChipFlight key={f.id} flight={f} onDone={removeChipFlight} />
              ))}

            </div>
          </div>
        </div>

        {/* ── Mobile hero cards strip: shown above action bar on small landscape screens ── */}
        {myHoleCards && (
          <div className="tbl-mobile-hero" style={{
            display: 'none',
            flexShrink: 0,
            justifyContent: 'center',
            alignItems: 'center',
            gap: 8,
            padding: '4px 0 2px',
          }}>
            {visibleHoleCount >= 1 && (
              <div style={{ lineHeight: 0, borderRadius: CARD_DIMS.sm.r + 2, boxShadow: '0 0 0 1.5px rgba(201,168,76,0.65), 0 4px 16px rgba(0,0,0,0.75)' }}>
                <PlayingCard c={myHoleCards[0]} size="sm" />
              </div>
            )}
            {visibleHoleCount >= 2 && (
              <div style={{ lineHeight: 0, borderRadius: CARD_DIMS.sm.r + 2, boxShadow: '0 0 0 1.5px rgba(201,168,76,0.65), 0 4px 16px rgba(0,0,0,0.75)' }}>
                <PlayingCard c={myHoleCards[1]} size="sm" />
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════════ BOTTOM ACTION PANEL ══ */}
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap');
          @keyframes card-deal-in{from{opacity:0;transform:translateY(-16px) scale(0.84) rotate(-5deg)}to{opacity:1;transform:translateY(0) scale(1) rotate(0deg)}}
          @keyframes pot-pulse{0%{transform:translateY(16px) scale(1)}45%{transform:translateY(16px) scale(1.14)}100%{transform:translateY(16px) scale(1)}}
          @keyframes winner-toast-in{from{opacity:0;transform:translateX(-50%) translateY(-10px) scale(0.9)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
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
          .ap-call{background:linear-gradient(180deg,#0e3320,#081d13);border:1px solid rgba(52,211,153,0.32);color:#34d399;}
          .ap-call:hover{box-shadow:0 0 18px rgba(52,211,153,0.2);}
          .ap-raise{flex:1.35 !important;background:linear-gradient(180deg,#3a2508,#241600);border:1px solid rgba(201,168,76,0.42);color:#e8c97a;}
          .ap-raise:hover{box-shadow:0 0 22px rgba(201,168,76,0.28);}
          .ap-allin{background:linear-gradient(180deg,#2e0f50,#1c0935);border:1px solid rgba(168,85,247,0.4);color:#c4b5fd;}
          .ap-allin:hover{box-shadow:0 0 18px rgba(168,85,247,0.24);}

          /* ── Hero seat cards — shown in seat pod by default ──────── */
          .tbl-hero-cards{}
          /* ── Mobile hero strip — hidden by default, shown on mobile ─ */
          .tbl-mobile-hero{display:none;}
          /* ── Showdown panel — capped so it never swallows the table ─ */
          .tbl-showdown-panel{max-height:min(420px,70vh);overflow-y:auto;}

          /* ── Compact bottom panel — pre-action buttons only, no status text ─ */
          .tbl-panel-compact{min-height:60px!important;}
          .tbl-panel-compact .tbl-main-col{padding-top:6px!important;padding-bottom:6px!important;}

          /* ── Theater mode: header hidden, table fills viewport ────── */
          /* The root div still has paddingTop:env(safe-area-inset-top) so   */
          /* content stays below the iOS status bar even without the header. */
          .tbl-theater .tbl-header{display:none!important;}

          /* ── Portrait lock — all phones in portrait ────────────────── */
          .portrait-lock{display:none;position:fixed;inset:0;z-index:9999;background:#060b15;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center;padding:32px;}
          @media (max-width:767px) and (orientation:portrait){.portrait-lock{display:flex;}}
          @keyframes portrait-rock{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(8deg)}}

          /* ── Mobile landscape overrides (short viewport) ─────────── */
          @media (max-height:500px) and (orientation:landscape){

            /* Header */
            .tbl-header{height:30px!important;padding:0 8px!important;}
            .tbl-hide-mobile{display:none!important;}

            /* Result panel — shift up to match shorter header, cap width */
            .tbl-result-panel{top:34px!important;max-width:calc(100vw - 24px)!important;}
            .tbl-showdown-panel{max-width:calc(100vw - 24px)!important;}

            /* Chat panel — smaller and tucked in the top-right so it stays clear of the table */
            .tbl-chat-panel{width:190px!important;top:34px!important;bottom:64px!important;}
            .tbl-chat-messages{font-size:10px!important;}

            /* Table wrap: let absolute child fill it cleanly */
            .tbl-table-wrap{overflow:hidden!important;}

/* Mobile seat scale by table size */
.tbl-table-inner[data-seatcount="2"],
.tbl-table-inner[data-seatcount="3"],
.tbl-table-inner[data-seatcount="4"]{ --mscale:0.70; }

.tbl-table-inner[data-seatcount="5"],
.tbl-table-inner[data-seatcount="6"]{ --mscale:0.62; }

.tbl-table-inner[data-seatcount="7"],
.tbl-table-inner[data-seatcount="8"],
.tbl-table-inner[data-seatcount="9"]{ --mscale:0.54; }

/* Community cards — scale down to save vertical space */
.tbl-community-row{transform:scale(0.76);transform-origin:center;}

            /* Pot pill — compact on small landscape screens */
            .tbl-pot-pill{padding:2px 8px!important;gap:4px!important;}
            .tbl-pot-amount{font-size:10px!important;}

            /* Seat pods */
            .tbl-player-circle{width:30px!important;height:30px!important;font-size:13px!important;}
            .tbl-player-circle-hero{width:36px!important;height:36px!important;font-size:17px!important;}
            .tbl-seat-pill{padding:1px 6px!important;min-width:48px!important;border-radius:5px!important;}
            .tbl-seat-pill-name{font-size:6px!important;letter-spacing:0.4px!important;}
            .tbl-seat-pill-stack{font-size:9px!important;}
            .tbl-seat-pill-action{font-size:5.5px!important;margin-top:0!important;}

            /* Empty seats — very subtle to reduce visual noise */
            .tbl-empty-seat{opacity:0.25!important;width:36px!important;height:36px!important;font-size:8px!important;}

            /* Hero seat: clean compact row above the action panel */
            .tbl-hero-seat{
              top:82%!important;
              left:50%!important;
              transform:translate(-50%,-50%) scale(0.95)!important;
              z-index:30!important;
            }

            .tbl-hero-row{
              gap:7px!important;
              padding:0 4px!important;
              align-items:center!important;
            }

            .tbl-hero-avatar-col{
              gap:2px!important;
               transform:translate(0px, 40px);
            }

            .tbl-hero-bet-stack{
              transform:scale(0.95);
              transform-origin:top center;
              margin-top:-5px!important;
            }

            .tbl-hero-pill{
              min-width:78px!important;
              padding:3px 7px!important;
            }

            .tbl-hero-info-col{
              align-items:flex-start!important;
              /* Pull closer to the cards — avatar↔cards keeps the full row gap */
              margin-left:-6px!important;
              transform:translate(-1px, 20px);
            }

            /* Hero cards stay inside the hero row instead of a separate strip */
            .tbl-hero-cards{
              display:flex!important;
              transform:scale(0.88);
              transform-origin:center;
            }

            /* Duplicate separate card strip — hidden now that cards live in the hero row */
            .tbl-mobile-hero{
              display:none!important;
            }

            /* Opponent hole/back cards — full width in the stacked pod layout below */
            .tbl-opponent-cards{
              transform-origin:center;
              justify-content:center;
            }

            /* Bet chips — scaled to match the pod density tier.          */
            /* Target the inner child, not the wrapper: the wrapper's     */
            /* position comes from mobileChipVars() below.                */
            .tbl-bet-chip > div{
              transform:scale(var(--mscale,0.55));
              transform-origin:top center;
            }

            /* Showdown panel — smaller and capped so it can't cover seats or the action bar */
            .tbl-showdown-panel{
              max-height:58vh!important;
              transform:scale(0.82);
              transform-origin:center;
              padding:6px 8px!important;
            }

            /* ── Fixed mobile-landscape seat presets (override oval math) ──────
               Every opponent pod is centred horizontally on a hand-picked point
               and stacks its content vertically (avatar / cards / pill) instead
               of side-by-side — a vertical stack is far narrower, which is what
               lets up to 8 opponents share a phone's limited width without
               overlapping. "vtop" pods (near the top rail) anchor at their own
               top edge and grow downward; "vmid" pods (down the side rails)
               anchor at vertical centre. See MOBILE_SEAT_PRESETS for the
               coordinates and mobileDensityScale() for --mscale. */
            .tbl-pod-vtop, .tbl-pod-vmid{
              left:var(--mleft)!important;
              top:var(--mtop)!important;
              transform:translate(-50%,var(--mty)) scale(var(--mscale,0.55))!important;
            }
            .tbl-pod-vtop{ transform-origin:50% 0%; }
            .tbl-pod-vmid{ transform-origin:50% 50%; }
            .tbl-pod-vtop .tbl-opponent-seat,
            .tbl-pod-vmid .tbl-opponent-seat{
              flex-direction:column!important;
            }

            /* Bet chips share the same fixed coordinates (interpolated toward the pot) */
            .tbl-bet-chip{
              left:var(--mleft)!important;
              top:var(--mtop)!important;
            }

            /* Neutralise the desktop seat-pill nudge so pills line up with the new anchors */
            .tbl-seat-pill{ transform:none!important; }

            /* Panel */
            .tbl-panel-outer{position:relative!important;z-index:20!important;}
            .tbl-panel-inner{min-height:0!important;align-items:stretch!important;}
            .tbl-main-col{padding:3px 6px!important;gap:2px!important;}

            /* ── Two-column action layout ─────────────────────────── */
            .tbl-actions-layout{flex-direction:row!important;align-items:stretch!important;gap:6px!important;}
            .tbl-btns-col{order:1!important;flex:0 0 auto!important;gap:3px!important;justify-content:center!important;}
            .tbl-raise-panel{order:2!important;flex:1!important;min-width:0!important;gap:3px!important;justify-content:center!important;border-left:1px solid rgba(255,255,255,0.07)!important;padding-left:7px!important;}
            .tbl-timer-text{display:none!important;}

            /* Raise row */
            .tbl-raise-row{padding:3px 5px!important;border-radius:6px!important;gap:4px!important;}
            .tbl-raise-row input[type="number"]{width:46px!important;font-size:12px!important;}

            /* Range thumb — bigger for touch */
            .ap-range::-webkit-slider-thumb{width:20px!important;height:20px!important;}
            .ap-range::-moz-range-thumb{width:20px!important;height:20px!important;}

            /* Quick bet buttons */
            .tbl-qb-row{flex-wrap:wrap!important;gap:3px!important;}
            .ap-qb{padding:5px 9px!important;font-size:10px!important;font-weight:700!important;border-color:rgba(255,255,255,0.15)!important;color:rgba(245,236,215,0.72)!important;}

            /* Pre-action */
            .tbl-preaction-label{display:none!important;}
            .tbl-preaction-row{gap:3px!important;}
            .tbl-preaction-row button{padding:5px 3px!important;font-size:9px!important;border-radius:6px!important;}

            /* Action buttons */
            .ap-btn{padding:6px 8px 5px!important;font-size:11px!important;border-radius:7px!important;letter-spacing:0.4px!important;}
            .ap-sub{font-size:8.5px!important;}
          }

          /* ── Very narrow screens (e.g. iPhone SE landscape 568px) ── */
          @media (max-height:380px) and (orientation:landscape){
            .tbl-header{height:26px!important;}
            .tbl-chat-panel{width:160px!important;top:30px!important;bottom:54px!important;}
            .tbl-player-circle{width:26px!important;height:26px!important;font-size:11px!important;}
            .tbl-player-circle-hero{width:30px!important;height:30px!important;font-size:14px!important;}
            .tbl-seat-pill{padding:1px 4px!important;min-width:38px!important;}
            .tbl-seat-pill-name{font-size:5px!important;}
            .tbl-seat-pill-stack{font-size:8px!important;}
            .tbl-community-row{transform:scale(0.66);transform-origin:center;}
            .ap-btn{padding:5px 6px 4px!important;font-size:10px!important;}
            .ap-qb{padding:3px 6px!important;font-size:9px!important;}

            /* Seat pods need to shrink further than the default --mscale on a   */
            /* viewport this short — set per table size via data-seatcount so    */
            /* dense (7-9 max) tables still fit without overlapping.             */
            .tbl-table-inner[data-seatcount="2"],
            .tbl-table-inner[data-seatcount="3"],
            .tbl-table-inner[data-seatcount="4"]{ --mscale:0.5; }
            .tbl-table-inner[data-seatcount="5"],
            .tbl-table-inner[data-seatcount="6"]{ --mscale:0.4; }
            .tbl-table-inner[data-seatcount="7"],
            .tbl-table-inner[data-seatcount="8"],
            .tbl-table-inner[data-seatcount="9"]{ --mscale:0.3; }
          }
        `}</style>
        <div className="tbl-panel-outer" style={{
          flexShrink: 0,
          background: 'rgba(7, 9, 14, 0.52)',
          backdropFilter: 'blur(28px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
          borderTop: '1px solid rgba(255,255,255,0.09)',
          boxShadow: '0 -1px 0 rgba(255,255,255,0.04)',
          // Push buttons above the iPhone home indicator while the panel
          // background visually fills the gap all the way to the screen edge
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}>
          <div className={`tbl-panel-inner${preActionOnly ? ' tbl-panel-compact' : ''}`} style={{ display: 'flex', alignItems: 'stretch', minHeight: 86 }}>

            {/* ── Main content column ───────────────────────────────── */}
            <div className="tbl-main-col" style={{ flex: 1, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, justifyContent: 'center' }}>

              {/* ── MY TURN: action bar ──────────────────────────────── */}
              {needsMyAction && (() => {
                const raiseDisabled = raiseAmount < minRaiseTo || raiseAmount > myMaxBet
                const sliderMax = Math.max(minRaiseTo + 1, myMaxBet)
                const sliderPct = Math.round(((Math.min(Math.max(raiseAmount, minRaiseTo), sliderMax) - minRaiseTo) / Math.max(1, sliderMax - minRaiseTo)) * 100)
                return (
                  /* tbl-actions-layout:
                     desktop → flex-col (raise panel above, buttons below)
                     mobile  → flex-row (buttons LEFT via order:1, raise RIGHT via order:2) */
                  <div className="tbl-actions-layout" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>

                    {/* ── RAISE PANEL — above btns on desktop, RIGHT col on mobile ── */}
                    {canRaise && (
                      <div className="tbl-raise-panel" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {/* Quick bets + timer text (timer text hidden on mobile) */}
                        <div className="tbl-qb-row" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {([
                              { l: 'Min',    fn: () => setRaiseAmount(minRaiseTo) },
                              { l: '½ Pot',  fn: () => quickBet(0.5) },
                              { l: 'Pot',    fn: () => quickBet(1.0) },
                              { l: 'Max',    fn: () => setRaiseAmount(myMaxBet) },
                            ] as const).map(q => (
                              <button key={q.l} onClick={q.fn} className="ap-qb">{q.l}</button>
                            ))}
                          </div>
                          <div style={{ flex: 1 }} />
                          {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                            <span className="tbl-timer-text" style={{ color: timeLeft <= 15 ? '#f87171' : '#fde047', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, minWidth: 26, textAlign: 'right' }}>{timeLeft}s</span>
                          )}
                        </div>
                        {/* Raise amount + slider */}
                        <div className="tbl-raise-row" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '9px 14px' }}>
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
                            style={{ flex: 1, background: `linear-gradient(to right,#c9a84c ${sliderPct}%,rgba(255,255,255,0.1) ${sliderPct}%)` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* ── BUTTONS COL — below raise on desktop, LEFT col on mobile ── */}
                    <div className="tbl-btns-col" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {/* Timer when no raise */}
                      {!canRaise && turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                          <span style={{ color: timeLeft <= 15 ? '#f87171' : '#fde047', fontWeight: 700, fontFamily: 'monospace', fontSize: 11 }}>{timeLeft}s</span>
                        </div>
                      )}
                      {/* Timer bar */}
                      {turnTimerInfo?.playerId === currentUserId && timeLeft > 0 && (
                        <div className="tbl-timer-bar" style={{ height: 3, borderRadius: 2, background: '#1e293b', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%', borderRadius: 2,
                            width: `${Math.min(100, (timeLeft / TIMER_TOTAL) * 100)}%`,
                            background: timeLeft <= 15 ? '#ef4444' : '#eab308',
                            transition: 'width 0.25s linear, background 0.3s',
                          }} />
                        </div>
                      )}
                      {/* Action buttons */}
                      <div className="tbl-btn-row" style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => sendAction('FOLD')} className="ap-btn ap-fold">
                          Fold<span className="ap-sub">Muck</span>
                        </button>

                        {canCheck ? (
                          <button onClick={() => sendAction('CHECK')} className="ap-btn ap-check">
                            Check<span className="ap-sub">No bet</span>
                          </button>
                        ) : mustGoAllIn ? (
                          <button onClick={() => sendAction('ALL_IN')} className="ap-btn ap-allin" style={{ flex: 1.35 }}>
                            All-In<span className="ap-sub">{formatNumber(myStack)}</span>
                          </button>
                        ) : (
                          <button onClick={() => sendAction('CALL')} className="ap-btn ap-call">
                            Call<span className="ap-sub">{formatNumber(callAmt)}</span>
                          </button>
                        )}

                        {canRaise && (
                          <>
                            <button
                              onClick={() => sendAction('RAISE', raiseAmount)}
                              disabled={raiseDisabled}
                              className="ap-btn ap-raise"
                            >
                              Raise<span className="ap-sub">to {formatNumber(raiseAmount)}</span>
                            </button>
                            <button onClick={() => sendAction('ALL_IN')} className="ap-btn ap-allin">
                              All-In<span className="ap-sub">{formatNumber(myStack)}</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                  </div>
                )
              })()}

              {/* ── IDLE: waiting / showdown / start / pre-actions ──── */}
              {!needsMyAction && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

                  {/* Pre-action buttons: shown when hand is live, it's not my turn, and I'm active */}
                  {myStatus === 'seated' && hand && !isMyTurn && myHP?.playerPhase === 'active' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="tbl-preaction-label" style={{ color: '#475569', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        Pre-Action
                      </span>
                      <div className="tbl-preaction-row" style={{ display: 'flex', gap: 5 }}>
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
                                {p.netChipChange > 0 ? '+' : ''}{formatNumber(p.netChipChange)}
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
