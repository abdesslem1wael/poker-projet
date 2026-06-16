'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'

type Ok  = { ok: true }
type Err = { error: string }
export type ActionResult = Ok | Err

export async function updateUsernameAction(username: string): Promise<ActionResult> {
  const trimmed = username.trim()
  if (!trimmed || trimmed.length < 2 || trimmed.length > 20) {
    return { error: 'Username must be 2–20 characters' }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { error: 'Only letters, numbers, _ and - allowed' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error } = await supabase
    .from('profiles')
    .update({ username: trimmed })
    .eq('id', user.id)

  if (error) {
    if (error.message.includes('unique') || error.code === '23505') {
      return { error: 'That username is already taken' }
    }
    return { error: error.message }
  }

  revalidatePath('/lobby')
  return { ok: true }
}

export async function changePasswordAction(
  newPassword: string,
  confirmPassword: string,
): Promise<ActionResult> {
  if (!newPassword || newPassword.length < 6) {
    return { error: 'Password must be at least 6 characters' }
  }
  if (newPassword !== confirmPassword) {
    return { error: 'Passwords do not match' }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Not authenticated' }

  const { error: pwError } = await supabase.auth.updateUser({ password: newPassword })
  if (pwError) return { error: pwError.message }

  await supabase
    .from('profiles')
    .update({ must_change_password: false })
    .eq('id', user.id)

  revalidatePath('/lobby')
  return { ok: true }
}
