'use client'

import { useEffect, useState } from 'react'
import { getSocket } from '@/lib/socket/client'
import PasswordChangeModal from './PasswordChangeModal'

// Always mounted on the lobby page (unlike PasswordChangeModal, which only
// renders when required) so it can pick up a live force_password_change
// push for a player who was already sitting on this page when an admin set
// must_change_password — the server-rendered initialRequired prop alone only
// catches a fresh page load/navigation.
export default function ForcePasswordChangeGate({ initialRequired }: { initialRequired: boolean }) {
  const [required, setRequired] = useState(initialRequired)

  useEffect(() => {
    let active = true
    let cleanup: (() => void) | null = null

    getSocket().then((socket) => {
      if (!active) return
      const onForce = () => { if (active) setRequired(true) }
      socket.on('force_password_change', onForce)
      cleanup = () => socket.off('force_password_change', onForce)
    })

    return () => { active = false; cleanup?.() }
  }, [])

  if (!required) return null
  return <PasswordChangeModal onSuccess={() => setRequired(false)} />
}
