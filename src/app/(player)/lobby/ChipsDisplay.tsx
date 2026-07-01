'use client'

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket/client'
import type { AppSocket } from '@/lib/socket/client'

export default function ChipsDisplay({ initialChips }: { initialChips: number | null }) {
  const [chips, setChips] = useState<number | null>(initialChips)

  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket: AppSocket) => {
      if (!active) return

      const onWalletUpdate = ({ chips: newChips }: { chips: number }) => {
        if (active) setChips(newChips)
      }

      socket.on('wallet_update', onWalletUpdate)
      cleanup = () => socket.off('wallet_update', onWalletUpdate)
    })

    return () => {
      active = false
      cleanup?.()
    }
  }, [])

  return (
    <p className="text-sm font-bold tabular-nums text-amber-400">
      {chips != null ? chips.toLocaleString('en-US') : '—'}
    </p>
  )
}
