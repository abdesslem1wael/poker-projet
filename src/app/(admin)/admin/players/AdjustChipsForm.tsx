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
      <section className="space-y-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
        <h2 className="text-lg font-semibold">Adjust Chips</h2>
        <p className="text-sm text-zinc-500">
          No players yet. Create a player first.
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Adjust Chips</h2>
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="playerId" className="block text-sm font-medium">
              Player
            </label>
            <select
              id="playerId"
              name="playerId"
              required
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username} ({p.chips.toLocaleString()} chips)
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="type" className="block text-sm font-medium">
              Type
            </label>
            <select
              id="type"
              name="type"
              required
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="admin_topup">Admin Top-up</option>
              <option value="admin_deduction">Admin Deduction</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="amount" className="block text-sm font-medium">
              Amount
            </label>
            <input
              id="amount"
              name="amount"
              type="number"
              required
              min={1}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="note" className="block text-sm font-medium">
              Note{' '}
              <span className="text-zinc-400 dark:text-zinc-500">(optional)</span>
            </label>
            <input
              id="note"
              name="note"
              type="text"
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
        </div>
        {state?.error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {pending ? 'Adjusting…' : 'Adjust Chips'}
        </button>
      </form>
    </section>
  )
}
