'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { changePasswordAction } from '@/app/actions/player'

export default function PasswordChangeModal() {
  const router                        = useRouter()
  const [newPw, setNewPw]             = useState('')
  const [confirmPw, setConfirmPw]     = useState('')
  const [error, setError]             = useState<string | null>(null)
  const [done, setDone]               = useState(false)
  const [isPending, startTransition]  = useTransition()

  function handleSubmit() {
    setError(null)
    startTransition(async () => {
      const res = await changePasswordAction(newPw, confirmPw)
      if ('error' in res) { setError(res.error); return }
      setDone(true)
      router.refresh()
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/85 sm:items-center">
      <div className="w-full max-w-md rounded-t-2xl border border-zinc-800 bg-zinc-900 px-5 pb-10 pt-6 shadow-2xl sm:rounded-2xl sm:pb-6 text-center">
        {/* Drag handle (mobile) */}
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-zinc-700 sm:hidden" />

        <div className="mb-3 text-4xl">🔐</div>
        <h2 className="mb-2 text-xl font-black text-zinc-100">Set Your Password</h2>
        <p className="mb-6 text-sm leading-relaxed text-zinc-500">
          Your account was created by an admin. Please set a personal password before continuing.
        </p>

        <div className="mb-4 flex flex-col gap-3 text-left">
          <input
            type="password"
            placeholder="New password (min 6 characters)"
            value={newPw}
            onChange={e => setNewPw(e.target.value)}
            disabled={done || isPending}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 transition-colors disabled:opacity-50"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPw}
            onChange={e => setConfirmPw(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            disabled={done || isPending}
            className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-base text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 transition-colors disabled:opacity-50"
          />
        </div>

        {error && (
          <p className="mb-4 rounded-lg border border-red-900/50 bg-red-900/20 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        {done ? (
          <p className="py-2 text-base font-bold text-emerald-400">Password set! Redirecting…</p>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={isPending || !newPw || !confirmPw}
            className="w-full rounded-xl bg-emerald-600 py-4 text-base font-bold text-white transition-colors active:bg-emerald-700 disabled:opacity-50"
          >
            {isPending ? 'Setting password…' : 'Set Password'}
          </button>
        )}
      </div>
    </div>
  )
}
