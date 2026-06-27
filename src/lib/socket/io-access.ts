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
