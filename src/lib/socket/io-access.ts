import 'server-only'
import type { Server as SocketServer, DefaultEventsMap } from 'socket.io'
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from './types'

type AppSocketServer = SocketServer<
  ClientToServerEvents,
  ServerToClientEvents,
  DefaultEventsMap,
  SocketData
>

export function getIo(): AppSocketServer | undefined {
  return (global as Record<string, unknown>).__socketIo as AppSocketServer | undefined
}

// Bridges a Next.js Server Action (different module graph, same Node
// process) into server.ts's Sit & Go auto-start check. server.ts installs
// the real implementation on `global` at startup; a 5s interval inside
// server.ts also calls it independently, so a missed/failed trigger here
// (e.g. server.ts not ready yet) is never fatal — just slower.
export function triggerSitGoCheck(): void {
  const fn = (global as Record<string, unknown>).__triggerSitGoCheck as (() => void) | undefined
  fn?.()
}

// Asks server.ts to rebuild and broadcast a table's table_state — used after
// a Server Action mutates DB state a connected client should see immediately
// (e.g. rebuySitGoAction). Routed through server.ts (rather than built here)
// because a correct table_state needs GameManager's in-memory hand state,
// which only exists inside server.ts's closure — building it from scratch
// here would wrongly report no hand in progress whenever one actually is.
export function triggerTableStateRefresh(tableId: string): void {
  const fn = (global as Record<string, unknown>).__triggerTableStateRefresh as ((tableId: string) => void) | undefined
  fn?.(tableId)
}
