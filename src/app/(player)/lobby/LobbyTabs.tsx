'use client'

import { useState } from 'react'
import TableCard from './TableCard'
import SitGoTableCard from './SitGoTableCard'

type CashTableRow = {
  id: string
  name: string
  small_blind: number
  big_blind: number
  max_players: number
  table_type: 'timer' | 'open'
  status: 'waiting' | 'active'
}

type SitGoTableRow = {
  id: string
  name: string
  buy_in: number
  starting_stack: number
  small_blind: number
  big_blind: number
  max_players: number
  prize_pool: number
  sit_go_status: 'registering' | 'ready' | 'running' | 'finished'
  registeredCount: number
  isRegistered: boolean
  blind_level: number
}

export default function LobbyTabs({
  cashTables,
  sitGoTables,
  canJoin,
  playerChips,
}: {
  cashTables: CashTableRow[]
  sitGoTables: SitGoTableRow[]
  canJoin: boolean
  playerChips: number
}) {
  const [tab, setTab] = useState<'cash' | 'sit_go'>('cash')

  return (
    <section>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl border border-zinc-800 bg-zinc-900/80 p-1">
        <button
          onClick={() => setTab('cash')}
          className={[
            'rounded-lg py-2 text-sm font-semibold transition-colors',
            tab === 'cash'
              ? 'bg-emerald-600 text-white shadow shadow-emerald-950/40'
              : 'text-zinc-500 hover:text-zinc-200',
          ].join(' ')}
        >
          Cash Games
        </button>
        <button
          onClick={() => setTab('sit_go')}
          className={[
            'rounded-lg py-2 text-sm font-semibold transition-colors',
            tab === 'sit_go'
              ? 'bg-emerald-600 text-white shadow shadow-emerald-950/40'
              : 'text-zinc-500 hover:text-zinc-200',
          ].join(' ')}
        >
          Sit & Go
        </button>
      </div>

      {tab === 'cash' ? (
        cashTables.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 py-14 text-center">
            <p className="text-zinc-500">No cash tables open right now.</p>
            <p className="mt-1 text-sm text-zinc-600">Ask an admin to create one.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {cashTables.map((t) => (
              <TableCard key={t.id} table={t} canJoin={canJoin} />
            ))}
          </div>
        )
      ) : sitGoTables.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800 py-14 text-center">
          <p className="text-zinc-500">No Sit & Go tables open right now.</p>
          <p className="mt-1 text-sm text-zinc-600">Ask an admin to create one.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {sitGoTables.map((t) => (
            <SitGoTableCard key={t.id} table={t} canRegister={canJoin} playerChips={playerChips} />
          ))}
        </div>
      )}
    </section>
  )
}
