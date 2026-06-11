'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { createTableAction } from '@/app/actions/tables'
import type { ActionState } from '@/app/actions/tables'

const inputClass =
  'w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900'

export default function CreateTableForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createTableAction,
    undefined
  )
  const [smallBlindStr, setSmallBlindStr] = useState('25')

  const smallBlindNum = parseInt(smallBlindStr, 10)
  const bigBlindDisplay =
    !isNaN(smallBlindNum) && smallBlindNum > 0
      ? (smallBlindNum * 2).toLocaleString()
      : '—'

  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">Create Table</h2>
      <form action={action} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <label htmlFor="name" className="block text-sm font-medium">
              Table Name
            </label>
            <input
              id="name"
              name="name"
              type="text"
              required
              placeholder="e.g. Friday Night High Stakes"
              className={inputClass}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="smallBlind" className="block text-sm font-medium">
              Small Blind
            </label>
            <input
              id="smallBlind"
              name="smallBlind"
              type="number"
              required
              min={1}
              value={smallBlindStr}
              onChange={(e) => setSmallBlindStr(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="space-y-1">
            <p className="text-sm font-medium">Big Blind (auto)</p>
            <div className="flex h-9 items-center rounded-md border border-zinc-200 bg-zinc-50 px-3 text-sm tabular-nums text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
              {bigBlindDisplay}
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="maxPlayers" className="block text-sm font-medium">
              Max Players
            </label>
            <select
              id="maxPlayers"
              name="maxPlayers"
              defaultValue="9"
              className={inputClass}
            >
              {[2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
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
          {pending ? 'Creating…' : 'Create Table'}
        </button>
      </form>
    </section>
  )
}
