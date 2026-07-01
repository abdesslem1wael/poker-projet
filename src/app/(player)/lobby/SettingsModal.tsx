'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { updateUsernameAction } from '@/app/actions/player'

type Props = { currentUsername: string }

export default function SettingsModal({ currentUsername }: Props) {
  const [open, setOpen]              = useState(false)
  const [username, setUsername]      = useState(currentUsername)
  const [error, setError]            = useState<string | null>(null)
  const [saved, setSaved]            = useState(false)
  const [isPending, startTransition] = useTransition()
  const containerRef                 = useRef<HTMLDivElement>(null)

  function openMenu() {
    setUsername(currentUsername)
    setError(null)
    setSaved(false)
    setOpen(true)
  }

  function handleSave() {
    setError(null)
    startTransition(async () => {
      const trimmed = username.trim()
      if (trimmed !== currentUsername) {
        const res = await updateUsernameAction(trimmed)
        if ('error' in res) { setError(res.error); return }
      }
      setSaved(true)
      setTimeout(() => { setSaved(false); setOpen(false) }, 1200)
    })
  }

  // Close on outside click or Escape — standard dropdown dismissal.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => (open ? setOpen(false) : openMenu())}
        aria-expanded={open}
        aria-label="Settings"
        className={[
          'flex items-center justify-center rounded-lg p-2 transition-colors',
          open
            ? 'bg-emerald-600/15 text-emerald-400 ring-1 ring-emerald-600/40'
            : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
        ].join(' ')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl ring-1 ring-black/40">
          <h2 className="mb-1 text-lg font-bold text-zinc-100">Profile Settings</h2>
          <p className="mb-5 text-sm text-zinc-500">Update your display name.</p>

          <div className="mb-4">
            <label className="mb-2 block text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Display Name
            </label>
            <input
              type="text"
              value={username}
              maxLength={20}
              onChange={e => setUsername(e.target.value)}
              className="w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-base text-zinc-100 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 transition-colors"
            />
          </div>

          {error && (
            <p className="mb-4 rounded-lg border border-red-900/50 bg-red-900/20 px-3 py-2 text-sm text-red-400">
              {error}
            </p>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={isPending || saved}
              className="flex-1 rounded-xl bg-emerald-600 py-3.5 text-sm font-bold text-white transition-colors active:bg-emerald-700 disabled:opacity-50"
            >
              {saved ? 'Saved ✓' : isPending ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              onClick={() => setOpen(false)}
              className="rounded-xl border border-zinc-700 px-5 py-3.5 text-sm font-semibold text-zinc-400 transition-colors active:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
