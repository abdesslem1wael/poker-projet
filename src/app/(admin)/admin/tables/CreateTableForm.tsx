'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import { createTableAction } from '@/app/actions/tables'
import type { ActionState } from '@/app/actions/tables'

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors'

export default function CreateTableForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createTableAction,
    undefined
  )
  const [smallBlindStr, setSmallBlindStr] = useState('25')
  const [tableType, setTableType] = useState<'timer' | 'open'>('timer')

  const smallBlindNum = parseInt(smallBlindStr, 10)
  const bigBlindDisplay =
    !isNaN(smallBlindNum) && smallBlindNum > 0
      ? (smallBlindNum * 2).toLocaleString()
      : '—'

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-800">
        <h2 className="font-semibold text-zinc-100">Create Table</h2>
      </div>
      <form action={action} className="p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <label htmlFor="name" className="block text-sm font-medium text-zinc-300">
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

          <div className="space-y-1.5">
            <label htmlFor="smallBlind" className="block text-sm font-medium text-zinc-300">
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

          <div className="space-y-1.5">
            <p className="text-sm font-medium text-zinc-300">Big Blind (auto)</p>
            <div className="flex h-9 items-center rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 text-sm tabular-nums text-zinc-400">
              {bigBlindDisplay}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="maxPlayers" className="block text-sm font-medium text-zinc-300">
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

          <div className="space-y-1.5 sm:col-span-2">
            <p className="block text-sm font-medium text-zinc-300">Table Type</p>
            <input type="hidden" name="tableType" value={tableType} />
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setTableType('timer')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  tableType === 'timer'
                    ? 'border-emerald-600 bg-emerald-600/10 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <span className="block font-semibold">Timer</span>
                <span className="block text-xs text-zinc-500">
                  Players are locked in until the session timer ends or an admin kicks them.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTableType('open')}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  tableType === 'open'
                    ? 'border-emerald-600 bg-emerald-600/10 text-emerald-300'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-zinc-600'
                }`}
              >
                <span className="block font-semibold">Open</span>
                <span className="block text-xs text-zinc-500">
                  Players can leave the table whenever they want.
                </span>
              </button>
            </div>
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
          {pending ? 'Creating…' : 'Create Table'}
        </button>
      </form>
    </section>
  )
}
