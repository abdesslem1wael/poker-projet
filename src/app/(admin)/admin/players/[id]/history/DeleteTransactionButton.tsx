'use client'

import { useActionState } from 'react'
import { deleteTransactionAction } from '@/app/actions/admin'
import type { ActionState } from '@/app/actions/admin'

type Props = { transactionId: string; playerId: string }

export default function DeleteTransactionButton({ transactionId, playerId }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    deleteTransactionAction,
    undefined
  )

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm('Delete this history entry? This only removes the log row — it does not change the player\'s current chip balance.')) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="transactionId" value={transactionId} />
      <input type="hidden" name="playerId" value={playerId} />
      {state?.error && (
        <p className="mb-1 text-xs text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded px-2 py-1 text-xs font-semibold text-red-400 border border-red-900/50 transition-colors hover:bg-red-900/30 disabled:opacity-40"
      >
        {pending ? '…' : 'Delete'}
      </button>
    </form>
  )
}
