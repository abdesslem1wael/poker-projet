'use client'

import { useActionState } from 'react'
import { loginAction } from '@/app/actions/auth'
import type { LoginState } from '@/app/actions/auth'

export default function LoginPage() {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    loginAction,
    undefined
  )

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-5 py-10">
      <div className="w-full max-w-sm space-y-8">

        {/* Branding */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/20 text-3xl">
            ♠
          </div>
          <h1 className="text-3xl font-black tracking-tight text-zinc-100">Poker</h1>
          <p className="mt-1 text-sm text-zinc-500">Private Texas Hold&apos;em</p>
        </div>

        {/* Form */}
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="block text-sm font-semibold text-zinc-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 transition-colors"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="block text-sm font-semibold text-zinc-300">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="w-full rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 transition-colors"
            />
          </div>

          {state?.error && (
            <div className="rounded-xl border border-red-900/50 bg-red-900/20 px-4 py-3">
              <p className="text-sm text-red-400">{state.error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-xl bg-emerald-600 py-4 text-base font-bold text-white transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50"
          >
            {pending ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}
