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
    <main className="relative flex min-h-screen flex-col items-center justify-center px-5 py-10 md:items-center md:justify-start md:pl-24">
      {/* Background image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/poker-login-bg.png"
        alt=""
        className="fixed inset-0 -z-20 h-full w-full object-cover object-[center_right]"
      />
      {/* Dark overlay: heavier on the left (form side), lighter over the table on the right */}
      <div className="fixed inset-0 -z-10 bg-gradient-to-r from-zinc-950/95 via-zinc-950/70 to-zinc-950/20" />
      <div className="fixed inset-0 -z-10 bg-gradient-to-b from-zinc-950/30 via-transparent to-zinc-950/50" />

      <div className="w-full max-w-sm space-y-8">

        {/* Branding */}
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-600/20 text-3xl ring-1 ring-emerald-500/30 backdrop-blur-sm">
            ♠
          </div>
          <h1 className="text-3xl font-black tracking-tight text-zinc-100 drop-shadow-lg">Poker</h1>
          <p className="mt-1 text-sm text-zinc-300">Private Texas Hold&apos;em</p>
        </div>

        {/* Form */}
        <form
          action={action}
          className="space-y-4 rounded-2xl border border-white/10 bg-zinc-900/40 p-6 shadow-2xl shadow-black/50 backdrop-blur-xl"
        >
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
              className="w-full rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 outline-none backdrop-blur-sm transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
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
              className="w-full rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3.5 text-base text-zinc-100 placeholder:text-zinc-500 outline-none backdrop-blur-sm transition-colors focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
            />
          </div>

          {state?.error && (
            <div className="rounded-xl border border-red-900/50 bg-red-900/20 px-4 py-3 backdrop-blur-sm">
              <p className="text-sm text-red-400">{state.error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-xl bg-emerald-600 py-4 text-base font-bold text-white shadow-lg shadow-emerald-900/40 transition-colors hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-50"
          >
            {pending ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </main>
  )
}
