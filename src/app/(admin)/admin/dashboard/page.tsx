import Link from 'next/link'
import { logoutAction } from '@/app/actions/auth'

export default function AdminDashboardPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <h1 className="text-lg font-bold">Admin Dashboard</h1>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Management
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            Select an area to manage.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Link
            href="/admin/players"
            className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
          >
            <div className="mb-3 text-2xl">👤</div>
            <h3 className="font-semibold text-zinc-100 group-hover:text-white">
              Players
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              View profiles, adjust chip balances, manage roles.
            </p>
          </Link>

          <Link
            href="/admin/tables"
            className="group rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 transition-colors hover:border-zinc-600 hover:bg-zinc-900"
          >
            <div className="mb-3 text-2xl">🃏</div>
            <h3 className="font-semibold text-zinc-100 group-hover:text-white">
              Tables
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              Create, configure, and close poker tables.
            </p>
          </Link>
        </div>

        <div className="border-t border-zinc-800 pt-4">
          <Link
            href="/lobby"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-300"
          >
            ← Back to Lobby
          </Link>
        </div>
      </div>
    </main>
  )
}
