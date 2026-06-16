'use client'

import { useActionState } from 'react'
import { createPlayerAction } from '@/app/actions/admin'
import type { ActionState } from '@/app/actions/admin'

export default function CreatePlayerForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    createPlayerAction,
    undefined
  )

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-800">
        <h2 className="font-semibold text-zinc-100">Create Player</h2>
      </div>
      <form action={action} className="p-5 space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-zinc-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-sm font-medium text-zinc-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={6}
              autoComplete="new-password"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="username" className="block text-sm font-medium text-zinc-300">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="off"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-emerald-600 focus:ring-1 focus:ring-emerald-600/30 transition-colors"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="startingChips" className="block text-sm font-medium text-zinc-300">
              Starting Chips
            </label>
            <input
              id="startingChips"
              name="startingChips"
              type="number"
              required
              min={0}
              defaultValue={1000}
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
          {pending ? 'Creating…' : 'Create Player'}
        </button>
      </form>
    </section>
  )
}
