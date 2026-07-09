# Restaurant City local server

A self-hosted replacement for PlayFish's dead backend, so the Restaurant City
Flash client (`game.swf`) runs offline. It does four things:

- **Serves the game's assets** (SWF, XML, `.bin`) from this repo.
- **Answers the game's binary RPC calls** with real responses.
- **Persists player state** (profile, inventory, garden, economy, mail, …) in a
  local SQLite database.
- **Captures every request** to a live dashboard, and exposes a web UI for
  editing the database.

Stack: Node.js + TypeScript on the built-in `http` module (no web framework),
Prisma 7 over SQLite via the better-sqlite3 adapter.

## Requirements

- Node.js 20 or newer (native `better-sqlite3` ships prebuilt binaries).
- A Flash player to run the client — e.g. the standalone debug player at
  `C:\flex\Player\flashplayer_32_sa_debug.exe` that `play.bat` expects.

## Quick start

```bat
start.bat        REM or: npm start
```

`npm start` pushes the Prisma schema to `dev.db`, compiles `src/` to `dist/`,
then runs `dist/server.js`. On boot it prints the URLs and how many assets it
indexed.

Then launch the client so it loads **from this server** (relative asset URLs
only resolve correctly when the SWF is served here):

```bat
play.bat
```

or open <http://localhost:8090/game> and use the launcher page.

| URL | Page |
|---|---|
| <http://localhost:8090/> or `/__dash` | Live request dashboard |
| <http://localhost:8090/game> | Client launcher |
| <http://localhost:8090/admin> | Database editor |

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | Listen port |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` exposes it on the LAN) |
| `MAX_LOG_ENTRIES` | `500` | Size of the in-memory request buffer |
| `RC_DB_PATH` | `server/dev.db` | SQLite file location |

## How it works

### Asset serving

`StaticFileIndex` builds an in-memory map of asset name → file path at startup
(rescan any time via `/__api/reindex`). Names are matched loosely: basename
only, lowercased, with browser download suffixes stripped — so a request for
`/lang_en.bin` resolves `bin-xml/lang_en[1].bin`.

Sources are indexed in this order, later ones winning on name collisions:

1. Repo root — top-level files including the original `game.swf`.
2. `bin-xml/` — game data (`.bin`, `.xml`).
3. `backup/` — original `.swf` assets (excluding `game.swf`).
4. `decompiled/bin/` — rebuilt `.swf` assets (including `game.swf`).
5. `decompiled/game/bin/game.swf` — forced as `game.swf` if present.

Net effect: a rebuilt `decompiled/game/bin/game.swf` is served in preference to
the original at the repo root. The boot banner reports which one is active.

### RPC

The client speaks PlayFish's binary RPC protocol. Requests to any path matching
`/g/rpc/`, `/g/billing/`, or `/g/fbfeed/` are decoded, dispatched by message
type, and answered as binary. `src/rpc/codec.ts` holds the varint/string/array
primitives; `src/rpc/index.ts` parses the envelope (including type-255 batches)
and assembles the reply; `src/rpc/responders.ts` implements each call.

### Sessions

There are no passwords. A username is turned into a stable PlayFish UID with an
FNV-1a hash and stored in the `rc_username` cookie; logging in creates the
profile row if it doesn't exist. Requests without the cookie fall back to a
default `Player` account. See `src/session.ts`.

### Persistence

Prisma models in `prisma/schema.prisma` cover the profile plus owned items,
inventory, ingredients, garden plots, floors, employees, mail, friend visits,
restaurant ranks, notifications, game events, stored images, cash transactions,
and the economy tables (pricepoints, purchasable items, ingredient market).
`saveProfile` (msgType 5) decodes the client's audit-change payload and applies
it to these tables.

## Endpoints

Pages and control routes served outside the RPC/asset paths:

| Route | Method | Purpose |
|---|---|---|
| `/`, `/__dash`, `/dashboard` | GET | Dashboard UI |
| `/game`, `/play` | GET | Client launcher page |
| `/admin`, `/database` | GET | Database editor UI |
| `/__events` | GET | SSE stream of captured requests |
| `/__api/requests` | GET | JSON snapshot of the capture buffer |
| `/__api/clear` | GET | Clear the capture buffer |
| `/__api/reindex` | GET | Rescan asset files |
| `/__api/session` | GET | Current logged-in account |
| `/__api/login` | POST | Set username, create profile |
| `/__api/logout` | POST | Clear the session cookie |
| `/__api/profile-image/:uid/:type.png` | GET | Render a stored ARGB image as PNG |
| `/__api/db/...` | GET/POST/PATCH/DELETE | Admin CRUD used by the editor |
| `/crossdomain.xml` | GET | Permissive Flash cross-domain policy |

## Project layout

| Path | Purpose |
|---|---|
| `src/server.ts` | Entrypoint and boot banner |
| `src/config.ts` | Env + path resolution (`ServerConfig`) |
| `src/http-server.ts` | Routing, static serving, dashboard/admin APIs, PNG encoder |
| `src/static-files.ts` | Fuzzy asset index |
| `src/session.ts` | Cookie-based accounts, username → UID hashing |
| `src/request-log.ts` | In-memory request ring buffer + SSE fan-out |
| `src/types.ts` | Shared request/RPC types |
| `src/rpc/codec.ts` | PlayFish binary primitives (read/write) |
| `src/rpc/index.ts` | Envelope parsing and batch/single dispatch |
| `src/rpc/calls.ts` | msgType → call-name table |
| `src/rpc/responders.ts` | Per-call response implementations |
| `src/rpc/save-profile-parser.ts` | Decoder for the `saveProfile` payload |
| `src/db/client.ts` | Prisma client (better-sqlite3 adapter) |
| `src/db/defaults.ts` | Seed values for new profiles and the economy |
| `src/db/profile-store.ts` | Profile read/write and `saveProfile` application |
| `src/db/rpc-store.ts` | Persistence for the remaining RPC calls |
| `src/db/admin-store.ts` | Queries behind the `/__api/db` editor |
| `prisma/schema.prisma` | SQLite schema |
| `prisma.config.ts` | Prisma 7 datasource config |
| `public/` | `index.html` (dashboard), `game.html`, `admin.html` |
| `server.js` | Shim that runs `dist/server.js`, or tells you to build |

## Scripts

| Command | Does |
|---|---|
| `npm start` | `db:push` → `build` → run `dist/server.js` |
| `npm run start:built` | Run `dist/server.js` without rebuilding |
| `npm run build` | `prisma generate` + `tsc` |
| `npm run check` | Type-check only (`tsc --noEmit`) |
| `npm run db:push` | Apply the schema to `dev.db` |
| `npm run db:generate` | Regenerate the Prisma client |

## Implemented RPC calls

| msgType | Call | | msgType | Call |
|---:|---|---|---:|---|
| 1 | `init` | | 43 | `waterFriendGarden` |
| 2 | `getAllFriends` | | 44 | `readBookmarkCount` |
| 3 | `getUserProfile` | | 45 | `writeBookmarkCount` |
| 4 | `getUsers` | | 46 | `sendNotification` |
| 5 | `saveProfile` | | 246 | `getPricepoints` |
| 17 | `swapIngredient` | | 247 | `pollEvents` |
| 19 | `sendMail` | | 248 | `getCashBalance` |
| 20 | `getMails` | | 249 | `getServerTime` |
| 25 | `quizzReply` | | 250 | `getPurchasableItems` |
| 32 | `buyMystryBox` | | 251 | `recordGameEvent` |
| 34 | `storeImage` | | 253 | `getTimeToken0` |
| 35 | `rankRestaurant` | | 254 | `ping` |
| 36 | `firstTimeVisitFriend` | | 255 | `batchOperation` (envelope) |
| 37 | `getRandomStreetUsers` | | | |
| 38 | `getGourmetStreetUsers` | | | |
| 40 | `purchaseCoinsWithPfCash` | | | |
| 41 | `purchaseCashItem` | | | |
| 42 | `purchaseCashItemIngredients` | | | |

Unimplemented message types return an empty body, which the client treats as a
failed call.

## Notes

- Newsletter images are ordinary static-file requests. If the PNG isn't present
  the dashboard logs the 404 rather than returning a placeholder.
- `dev.db`, `dist/`, and `node_modules/` are gitignored — the database is
  recreated by `db:push` and the build by `npm start`.
