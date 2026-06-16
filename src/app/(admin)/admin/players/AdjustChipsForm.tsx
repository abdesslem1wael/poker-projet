'use client'

import { useActionState } from 'react'
import { adjustChipsAction } from '@/app/actions/admin'
import type { ActionState } from '@/app/actions/admin'

export type PlayerSummary = {
  id: string
  username: string
  chips: number
}

type Props = {
  players: PlayerSummary[]
}

export default function AdjustChipsForm({ players }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    adjustChipsAction,
    undefined
  )

  if (players.length === 0) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h2 className="font-semibold text-zinc-100">Adjust Chips</h2>
        </div>
        <p className="px-5 py-6 text-sm text-zinc-500">
          No players yet. Create a player first.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-800">
        <h2 className="font-semibold text-zinc-100">Adjust Chips</h2>
      </div>
      <form action={action} className="p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="playerId" className="block text-sm font-medium text-zinc-300">
              Player
            </label>
            <select
              id="playerId"
              name="playerId"
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            >
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username} ({p.chips.toLocaleString()} chips)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="type" className="block text-sm font-medium text-zinc-300">
              Type
            </label>
            <select
              id="type"
              name="type"
              required
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            >
              <option value="admin_topup">Top-up (add chips)</option>
              <option value="admin_deduction">Deduction (remove chips)</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="amount" className="block text-sm font-medium text-zinc-300">
              Amount
            </label>
            <input
              id="amount"
              name="amount"
              type="number"
              required
              min={1}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="note" className="block text-sm font-medium text-zinc-300">
              Note{' '}
              <span className="text-zinc-500 font-normal">(optional)</span>
            </label>
            <input
              id="note"
              name="note"
              type="text"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>
        </div>
        {state?.error && (
          <p role="alert" className="rounded-lg border border-red-900/50 bg-red-900/20 px-3 py-2 text-sm text-red-400">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {pending ? 'Adjusting…' : 'Adjust Chips'}
        </button>
      </form>
    </section>
  )
}
