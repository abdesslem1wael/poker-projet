'use client'

import { useActionState } from 'react'
import { deleteTableAction } from '@/app/actions/tables'
import type { ActionState } from '@/app/actions/tables'

type Props = { tableId: string; tableName: string }

export default function DeleteTableButton({ tableId, tableName }: Props) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    deleteTableAction,
    undefined
  )

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(`Delete "${tableName}"? This will permanently remove the table and all its tips.`)) {
          e.preventDefault()
        }
      }}
    >
      <input type="hidden" name="tableId" value={tableId} />
      {state?.error && (
        <p className="mb-1 text-xs text-red-400">{state.error}</p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded px-2.5 py-1 text-xs font-semibold text-red-400 border border-red-900/50 transition-colors hover:bg-red-900/30 disabled:opacity-40"
      >
        {pending ? '…' : 'Delete'}
      </button>
    </form>
  )
}
