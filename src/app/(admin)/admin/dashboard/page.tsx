import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'

export default function AdminDashboardPage() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-6">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold">Admin Dashboard</h1>
        <p className="text-zinc-500 dark:text-zinc-400">
          Player management and table controls will go here.
        </p>
      </div>
      <nav className="flex flex-col items-center gap-3">
        <Link
          href="/admin/players"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Manage Players
        </Link>
        <Link
          href="/admin/tables"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Manage Tables
        </Link>
        <form action={logoutAction}>
          <button
            type="submit"
            className="rounded-md border border-zinc-300 px-4 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </form>
      </nav>
    </main>
  )
}
