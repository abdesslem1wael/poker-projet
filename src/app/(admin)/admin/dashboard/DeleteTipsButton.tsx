'use client'

import { useActionState } from 'react'
import { deleteDealerTipsAction } from '@/app/actions/tables'
import type { ActionState } from '@/app/actions/tables'

type Props = { groupKey: string; archived: boolean; tableName: string }

export default function DeleteTipsButton({ groupKey, archived, tableName }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    deleteDealerTipsAction,
    undefined
  )

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Permanently delete collected tips for "${tableName}"? This cannot be undone.`)) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="groupKey" value={groupKey} />
      <input type="hidden" name="archived" value={archived ? 'true' : 'false'} />
      {state?.error && (
        <p className="mb-1 text-xs text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded px-2 py-1 text-xs font-semibold text-red-400 border border-red-900/50 transition-colors hover:bg-red-900/30 disabled:opacity-40"
      >
        {pending ? '…' : 'Delete tips'}
      </button>
    </form>
  )
}
