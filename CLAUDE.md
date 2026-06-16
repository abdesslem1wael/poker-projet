# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev:socket   # Start the app (Next.js + Socket.io combined server)
npm run lint         # ESLint
npm run test         # Run all tests once
npm run test:watch   # Run tests in watch mode
npm run build        # Production build
```

**Never use `npm run dev`** — the app requires a custom HTTP server (`server.ts`) to co-host Socket.io alongside Next.js. `npm run dev` starts Next.js standalone and leaves Socket.io unavailable.

Run a single test file:
```bash
npx vitest run tests/poker/game-manager.test.ts
```

## Architecture

### Single-process server (`server.ts`)

The entry point is `server.ts`, not Next.js. It creates one Node HTTP server that handles both Next.js page requests and Socket.io connections on the same port (3000). Next.js is loaded via `next()` and its request handler is passed to the HTTP server.

Two singletons live for the process lifetime:
- **`GameManager`** — all in-memory poker hand state. If the server restarts, every running hand is lost.
- **`SessionManager`** — in-memory 1-hour session tracking per table.

### Socket.io event flow

Authentication: every socket connection is verified via Supabase `auth.getUser(token)` in `io.use(...)`. The JWT comes from `socket.handshake.auth.token`, sent by the browser client after calling `supabase.auth.getSession()`.

Socket rooms:
- `table:{tableId}` — all sockets at a table (seated + spectating)
- `admin_room` — all admin sockets (for cross-table `session_update` broadcasts)

The canonical hand lifecycle on the server:
1. `start_hand` → `doStartHand()` → `GameManager.startHand()` → emits `deal_cards` (per socket, private), `table_state`, `turn_timer_start`
2. `player_action` → `GameManager.processAction()` → emits `action_result`, then either `showdown_result` (hand over) or the next `turn_timer_start`
3. Turn timeout → auto-CHECK or auto-FOLD → same path as `player_action`
4. All-in runout → `handleAllInRunout()` deals streets with 2-second delays between them
5. Hand ends → `handleHandEnd()` → `computeShowdown()` → persist to DB → emit `showdown_result` → `scheduleAutoStart()` (5 s delay)

### Card privacy boundary

`src/lib/socket/game-types.ts` is **server-only** — it contains `holeCards`, `deckRemaining`, and the private `HandState`. It is never imported from client code.

`src/lib/socket/types.ts` is the **shared protocol** file — safe for both client and server. `PublicHandState` and `PublicPlayerHandState` never include hole cards.

Hole cards flow exclusively via the `deal_cards` socket event, emitted per-socket to the owning player only (`s.emit(...)`, not `io.to(room).emit(...)`).

### Supabase client tiers

| File | Key used | Use in |
|---|---|---|
| `src/lib/supabase/browser.ts` | anon | Client components, socket auth |
| `src/lib/supabase/server.ts` | anon + cookies | Server components, Server Actions |
| `src/lib/supabase/admin.ts` | service role | Server Actions that need cross-user data; `server.ts` socket handlers |

`src/lib/supabase/server.ts` and `src/lib/supabase/admin.ts` both import `server-only` and must never end up in the client bundle.

`server.ts` creates its own service-role Supabase client directly (it runs outside the Next.js module graph, so it cannot use the helpers in `src/lib/supabase/`).

### Auth and authorization

`src/proxy.ts` is Next.js 16 Proxy (formerly Middleware). It **only** refreshes the Supabase session cookie and redirects unauthenticated visitors to `/login`. It does **not** check roles.

Admin role authorization is enforced in:
- `src/app/(admin)/layout.tsx` — redirects non-admins out of `/admin/*`
- `src/app/actions/tables.ts` and `src/app/actions/admin.ts` — `requireAdmin()` guard at the top of each action

### Database tables (Supabase / Postgres)

| Table | Purpose |
|---|---|
| `profiles` | One row per auth user; stores `username`, `role`, `avatar_id` |
| `wallets` | One row per user; `chips` balance (never goes negative — DB constraint) |
| `transactions` | Win/loss ledger, inserted after each hand |
| `poker_tables` | Table config (`small_blind`, `big_blind`, `max_players`, `status`) |
| `table_players` | Who is at which table; `status ∈ {seated, spectating, left}` |
| `game_history` | Completed hand records with `result_json` and `chip_deltas_json` |
| `dealer_tips` | Voluntary tips sent by players after winning |

`table_players` has a partial unique index that enforces one active entry per player per table and one player per seat.

### Front-end structure

The player-facing table UI lives entirely in `src/app/(player)/table/[id]/TableRoom.tsx` (a large `'use client'` component). The Server Component `page.tsx` in the same directory fetches initial state and renders `<TableRoom>`, passing `initialState`, `currentUserId`, `myStatus`, and `mySeatNumber` as props.

Seat positions are computed client-side via `toVisual()` / `seatPos()` — seats are arranged on an oval with the current player's seat anchored at the bottom.

`src/lib/socket/client.ts` is the browser-side socket singleton (`'use client'`). Always obtain the socket via `getSocket()` — it handles auth token attachment and reconnection.

### Poker engine

Pure TypeScript modules in `src/lib/poker/`:
- `deck.ts` — card creation and shuffle
- `evaluator.ts` — 5-card hand ranking (`HandRank` enum 1–10)
- `winner.ts` — side-pot distribution (`distributeWinnings`)
- `pot.ts` — pot building helpers

`src/lib/socket/showdown-helper.ts` bridges the engine to the socket protocol: given `HandEndedData`, it computes chip deltas, applies tips, and produces `ShowdownPayload`.

Tests in `tests/poker/` cover `GameManager` and the showdown logic using a minimal Supabase mock.
