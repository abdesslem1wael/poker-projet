'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import { broadcastForcePasswordChangeAction } from '@/app/actions/admin'
import type { ActionState } from '@/app/actions/admin'

export default function ForcePasswordChangeButton() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    broadcastForcePasswordChangeAction,
    undefined
  )
  const [justSent, setJustSent] = useState(false)
  const wasPending = useRef(false)

  useEffect(() => {
    if (wasPending.current && !pending && !state?.error) {
      setJustSent(true)
      const t = setTimeout(() => setJustSent(false), 3000)
      return () => clearTimeout(t)
    }
    wasPending.current = pending
  }, [pending, state])

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(
          'Push a forced password-change prompt to every currently connected player who still needs to change their password?'
        )) {
          e.preventDefault()
        }
      }}
      className="flex items-center gap-2"
    >
      {state?.error && <p className="text-xs text-red-400">{state.error}</p>}
      {justSent && <p className="text-xs text-emerald-400">Notified connected players.</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded px-2.5 py-1.5 text-xs font-semibold text-amber-400 border border-amber-900/50 transition-colors hover:bg-amber-900/30 disabled:opacity-40"
      >
        {pending ? 'Notifying…' : 'Force password change (active sessions)'}
      </button>
    </form>
  )
}
