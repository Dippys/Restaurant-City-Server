# Restaurant City Reborn — local server

A self-contained backend for **Restaurant City Reborn** (the revival of
Playfish's 2010 Flash game), so the Restaurant City client (`game.swf`) runs
in a modern browser via Ruffle. It does four things:

- **Serves the game's assets** (SWF, XML, `.bin`) from this repo.
- **Answers the game's binary RPC calls** with real responses.
- **Persists player state** (profile, inventory, garden, economy, mail, …) in a
  local SQLite database.
- **Creates safe social links** with Discord previews, explicit claims,
  transactional escrow, friendships, and administrator campaigns.
- **Ranks explainable profile anomalies** and provides immutable rollback,
  account-ban, and session-termination controls to administrators.
- **Captures every request** to a live dashboard, and exposes a web UI for
  editing the database.

Stack: Node.js + TypeScript on the built-in `http` module (no web framework),
Prisma 7 over SQLite via the better-sqlite3 adapter, with a pinned local Ruffle
fork for the browser game page.

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
| <http://localhost:8090/> | Public home page |
| <http://localhost:8090/login> and `/signup` | Account access |
| <http://localhost:8090/game> | Authenticated client launcher |
| <http://localhost:8090/account> | Name and PIN settings |
| `/terms`, `/privacy`, `/cookies`, `/community-guidelines` | Policy pages (see `public/legal.html`) |
| `/robots.txt`, `/sitemap.xml` | SEO (canonical `https://rc-reborn.uk`) |
| `/admin` | **The single admin dashboard** (overview, live traffic, players, economy, game tools, assets) |
| `/s/<slug>` | Public crawler-safe social-link landing page |
| `/__dash`, `/dashboard`, `/database` | Redirect to `/admin` (legacy aliases) |

## Deployment

Production hosting (Ubuntu + nginx + HTTPS + systemd) is covered in
[`deploy/README.md`](../deploy/README.md) — the nginx site config and the
systemd unit live in [`deploy/`](../deploy/). Behind nginx, set
`RC_TRUST_PROXY=true` (see the production checklist below).

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | Listen port |
| `HOST` | `0.0.0.0` | Bind address (`0.0.0.0` exposes it on the LAN) |
| `MAX_LOG_ENTRIES` | `500` | Size of the in-memory request buffer |
| `RC_DB_PATH` | `server/dev.db` locally; required in production | SQLite file location. Production must use a durable path outside the release directory, e.g. `/var/lib/rc-reborn/dev.db`. |
| `RC_ADMIN_USERNAME` | empty | Username promoted to admin when first registered |
| `RC_PIN_PEPPER` | empty | Optional stable server secret mixed into PIN hashes |
| `RC_TRUST_PROXY` | `false` | Trust forwarded IP/protocol headers only behind your proxy |
| `RC_SEED_STARTER_FRIENDS` | `false` | Set `true` only for local/demo servers that need the six legacy NPC profiles |
| `RC_SOCIAL_DISABLED_KINDS` | empty | Comma-separated social-link kinds whose creation/actions are paused while public pages stay readable |
| `RC_PUBLIC_ORIGIN` | request origin | Canonical HTTPS origin used for public link and Open Graph URLs |
| `RC_DISCORD_ANOMALY_WEBHOOK` | empty | Optional Discord webhook for new or changed anomaly evidence; the secret remains environment-only |
| `RC_MODERATION_SCAN_INTERVAL_MINUTES` | `60` | Full non-admin profile scan interval (minimum effective interval: 5 minutes) |
| `RC_MODERATION_SNAPSHOT_RETENTION_DAYS` | `90` | Age limit for unprotected profile rollback snapshots |
| `RC_MODERATION_MAX_SNAPSHOTS_PER_PLAYER` | `250` | Per-player count limit for unprotected rollback snapshots |

## How it works

### Asset serving

The server is **self-contained** (ADR-0011): every served asset lives under
`public/` and nothing outside `server/` is read at runtime.

| Path | Contents |
|---|---|
| `public/swf/` | The served SWFs — **decompiled/rebuilt versions**: `game.swf` (rebuilt client, crash fixes applied) + the 9 processed asset SWFs |
| `public/data/` | The game-data files (`<name>[1].bin`, e.g. `lang_en[1].bin`) plus the decompressed `.xml` views (`recipe.xml`, `ingredient.xml` are read directly by the recipe catalog at boot) |
| `public/ruffle/` | Vendored Ruffle runtime (see below) |
| `public/*.html`, `assets/` | Pages and dashboard art |

`StaticFileIndex` builds an in-memory map of asset name → file path at startup
(rescan any time via `/__api/reindex`). Names are matched loosely: basename
only, lowercased, with browser download suffixes stripped — so a request for
`/lang_en.bin` resolves `public/data/lang_en[1].bin` and `/game.swf` resolves
`public/swf/game.swf`.

The raw 2010 originals are preserved read-only under the workspace
`original/` (archive only — not read by the server). The boot banner reports
that the rebuilt `game.swf` is active. Note: the served `game.swf` carries a
**domain lock** — it only boots on `rc-reborn.uk` (+ localhost for dev); see
`docs/release.md` → "Domain lock".

### Ruffle

The browser game page (`/game`) mounts the original SWF through the
[Ruffle](https://ruffle.rs) Flash emulator. The runtime is built from the local
`../ruffle/` fork on branch `rc-reborn/restaurant-lag`, based on upstream
commit `19df9521b385a9449c63ba7da764fcd58692dbd8`, and vendored under
`public/ruffle/` so the release is self-contained. This fork implements the
AVM2 `System.gc()` boundary used when old restaurant worlds are detached;
active friend-visit/QTE scenes retain a separate performance cost.
`http-server.ts` falls back to the npm package only if the vendored copy is
missing. Build and upgrade instructions, source rationale, and pinned hashes
are in `../docs/release.md`.

### RPC

The client speaks PlayFish's binary RPC protocol. Requests to any path matching
`/g/rpc/`, `/g/billing/`, or `/g/fbfeed/` are decoded, dispatched by message
type, and answered as binary. `src/rpc/codec.ts` holds the varint/string/array
primitives; `src/rpc/index.ts` parses the envelope (including type-255 batches)
and assembles the reply; `src/rpc/responders.ts` implements each call.

### Sessions

Accounts require a unique username, first and last name, and a 6-12 digit PIN.
PINs are salted and hashed with scrypt. The browser receives a random HttpOnly,
SameSite session token; only its SHA-256 hash is stored. Sessions expire after
30 days and state-changing browser APIs require a CSRF token. Unauthenticated
RPC requests are rejected. See `src/session.ts` and `src/db/auth-store.ts`.

### Persistence

Prisma models in `prisma/schema.prisma` cover the profile plus owned items,
inventory, ingredients, garden plots, floors, employees, mail, friend visits,
restaurant ranks, notifications, game events, stored images, cash transactions,
and the economy tables (pricepoints, purchasable items, ingredient market).
`saveProfile` (msgType 5) decodes the client's audit-change payload and applies
it to these tables in one transaction. RPC `init` establishes an opaque
per-launch save fence in the authenticated `Session` row. The server atomically
accepts only the next version, treats an exact payload retry as already applied,
and rejects a stale or conflicting version before any scalar, currency,
placement, floor, or garden mutation (ADR-0031). Before owner-profile delivery, restart-local negative
placement IDs are normalized to stable positive IDs. Impossible duplicate
façade singletons are reconciled by keeping the newest active item and returning
older ones to inventory (ADR-0024). A missing starter façade singleton is
restored only when another item occupies its exact legacy negative slot and no
same-group item remains in inventory (ADR-0025); mere absence and ordinary
decorations are untouched. The identical proof also recovers the required
interior Simple Door when its starter slot `-13` was overwritten (ADR-0026).
Normalization updates both `OwnedItem.serverId` and its deterministic primary
key (ADR-0027), leaving the SWF's freshly reused negative IDs available for new
avatar/furniture saves instead of producing a Prisma unique-key failure.

### Moderation and profile recovery

ADR-0034 adds server-owned evidence without changing the PlayFish RPC bytes.
Every accepted profile save records compact before/after facts and first stores
the complete gameplay state immediately before the commit. The first scheduled
scan gives older profiles one `INITIAL_BASELINE` snapshot. The **Anomalies**
admin page ranks reason-coded findings and shows the exact evidence, measured
activity since deployment, accepted-save history, rollback points, and the
moderation audit trail. Findings never punish a player automatically.

Rollback and reset are transactional, create a recovery snapshot first, retain
account/mail/social/audit history, and revoke active sessions. Ban uses the
existing disabled-account gate and also removes persistent and in-memory game
state; unban is explicit. Configure `RC_DISCORD_ANOMALY_WEBHOOK` to deliver an
idempotent `@here` digest of new or changed evidence after the startup/hourly
scan. User-controlled text is mention-escaped, so only the digest's deliberate
channel ping can notify members.

## Endpoints

Pages and control routes served outside the RPC/asset paths:

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Public home page |
| `/login`, `/signup`, `/account` | GET | Account pages |
| `/terms`, `/privacy`, `/cookies`, `/community-guidelines` | GET | Policy pages |
| `/__dash`, `/dashboard`, `/database` | GET | Redirect to the single `/admin` dashboard (legacy aliases) |
| `/game`, `/play` | GET | Client launcher page |
| `/admin` | GET | **The single admin dashboard** (overview, live traffic, players, economy, game tools, assets; `src/admin/` is its typed TS source, compiled to `public/admin/`) |
| `/__events` | GET | SSE stream of captured requests |
| `/__api/requests` | GET | JSON snapshot of the capture buffer |
| `/__api/clear` | POST | Admin-only: clear the capture buffer |
| `/__api/reindex` | POST | Admin-only: rescan asset files |
| `/__api/admin/overview` | GET | Admin: server health (asset count, buffer stats, online players, uptime, DB size) |
| `/__api/admin/assets` | GET | Admin: indexed asset list (served name → file → size) |
| `/__api/session` | GET | Current logged-in account |
| `/__api/login`, `/__api/signup` | POST | Authenticate or create an account |
| `/__api/account` | PATCH | Update names/PIN after PIN re-verification |
| `/__api/logout` | POST | Revoke the current session |
| `/__api/profile-image/:uid/:type.png` | GET | Render a stored ARGB image as PNG |
| `/__api/social-links` | POST | Create a validated player-template link |
| `/__api/social-links/:slug` | GET | Public/viewer-specific link state |
| `/__api/social-links/:slug/actions` | POST | Explicit authenticated action |
| `/__api/social-links/:slug/cancel` | POST | Creator cancellation and escrow return |
| `/__api/admin/social-links...` | GET/POST/PATCH | Campaign lifecycle, audit, and CSV export |
| `/__api/live/online` | GET | Admin: current RPC 247 online-session roster |
| `/__api/live/alert` | POST | Admin: enqueue a live popup for one or all online players |
| `/__api/live/mail` | POST | Admin: type-safe mail fan-out to online, enabled, or selected players |
| `/__api/moderation` | GET | Admin: anomaly queue, current evidence, activity, and latest scan |
| `/__api/moderation/scan` | POST | Admin: run the full scan, Discord delivery, and snapshot cleanup now |
| `/__api/moderation/players/:uid` | GET | Admin: one player's findings, saves, snapshots, and action history |
| `/__api/moderation/players/:uid/{snapshots,rollback,reset,ban,unban,terminate}` | POST | Admin: recoverable moderation controls; destructive controls require a reason |
| `/__api/moderation/findings/:id` | PATCH | Admin: review, dismiss, confirm, or reopen a finding with a note |
| `/__api/db/...` | GET/POST/PATCH/DELETE | Admin CRUD used by the editor |
| `/crossdomain.xml` | GET | Same-origin-only Flash policy |

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
| `src/moderation/` | Evidence rules, scan persistence, Discord digest, snapshots, rollback, and scheduler |
| `src/db/rpc-store.ts` | Persistence for the remaining RPC calls |
| `src/db/admin-store.ts` | Queries behind the `/__api/db` editor |
| `prisma/schema.prisma` | SQLite schema |
| `prisma.config.ts` | Prisma 7 datasource config |
| `public/` | Self-contained asset store + pages: `swf/` (served SWFs), `data/` (game-data `.bin`/`.xml` + decompressed views), `ruffle/` (vendored Ruffle), `assets/` (site art), `admin/` (compiled admin dashboard JS), `index.html`/`game.html`/`admin.html`/… |
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

### Purge inactive accounts

`scripts/purge-inactive-users.cjs` removes non-admin accounts whose newest
registration, login, or session activity is older than 30 days. It also removes
profiles that have no matching account, while always preserving the permanent
Restaurant City system profile at UID `1`. Run the dry run first from `server/`:

```bash
node scripts/purge-inactive-users.cjs
```

Review every deletion and employee reassignment, stop the game server, then
apply the same plan:

```bash
node scripts/purge-inactive-users.cjs --apply
```

Apply mode creates a timestamped `dev.db.before-inactive-purge-*.bak` beside
the database, recalculates the plan under a SQLite write lock, reassigns stale
workers and their furniture references, and only then deletes accounts and
profiles. Replacement workers are active account-backed profiles and are unique
inside each restaurant. The same person may work in different restaurants.
Admins are never deleted. If a unique replacement is unavailable or furniture
contains a stale assignment without a matching employee row, the entire
transaction aborts. Use `--days N` or `--database PATH` when needed; `RC_DB_PATH`
is honored.

## Production checklist

The application security controls are implemented, but deployment security is
also required:

1. Put the Node server behind an HTTPS reverse proxy and never expose the
   dashboard/admin routes through a separate unauthenticated proxy rule.
2. Set a long random `RC_PIN_PEPPER` before the first public account is created,
   store it in the deployment secret manager, and do not rotate it without a
   PIN migration plan.
3. Set `RC_ADMIN_USERNAME` for the initial operator account before registering
   it. Remove the variable afterward; roles remain in the database.
4. Set `RC_TRUST_PROXY=true` only when the server is reachable solely through a
   trusted proxy. The proxy must replace (not append untrusted) forwarded
   protocol and client-IP headers.
5. Set `RC_DB_PATH` to durable storage outside the application release
   directory (for example `/var/lib/rc-reborn/dev.db`). Deployment syncs must
   exclude SQLite databases, WAL/SHM files, and backups. Back it up off-host,
   test restores, restrict filesystem permissions,
   and use a production database strategy before running multiple Node
   instances. SQLite is a single-host deployment choice.
6. The policy pages (`public/legal.html`: terms, privacy, cookies, community
   guidelines) are final as shipped, naming the Restaurant City Project as
   operator with in-service contact and England & Wales governing law. Have
   local counsel review them for the jurisdiction where you publicly deploy.
7. Decide how existing pre-authentication profiles are assigned to their real
   owners before opening public signup; a matching legacy username currently
   reconnects to that existing game profile.
8. Set `RC_DISCORD_DAILY_INGREDIENTS_WEBHOOK` in the deployment secret manager
   to enable the 12:00 UTC ingredient announcement. The server rotates exactly
   three coin-market rows even without it; failed/pending Discord delivery is
   retried after configuration. Never commit or log the webhook URL.

Preview the deterministic announcement image after a build with:

```bash
npm run preview:daily-ingredients
```

The preview is written under ignored `test/.tmp/`. The live renderer uses the
original `/public/assets/ingredients/<id>.png` art and the shipped ingredient
names, so the image and profile market cannot disagree.

After a deployment, an administrator can open **Admin → Game tools → Daily
ingredients** and press **Force daily ingredient sync**. This creates today's
UTC rotation if missing, restores its three market rows, and retries a pending
Discord delivery. Repeating it does not reroll or repost a completed date.

There is intentionally no PIN-by-email reset yet because the system does not
collect verified email addresses. Account recovery must be an operator-assisted
identity check or a separately designed verified recovery system; do not add an
insecure security-question reset.

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
| 39 | `getHireCandidates` | | | |
| 40 | `purchaseCoinsWithPfCash` | | | |
| 41 | `purchaseCashItem` | | | |
| 42 | `purchaseCashItemIngredients` | | | |

`getUsers` honors the leading AS3 `itemContext` mask when serializing owned
placements. In particular, facade (`2`) and restaurant-interior (`4`) requests
return disjoint item sets; the client appends both responses during a friend
visit (ADR-0012 in `../client-html5/docs/adr/`).

`getRandomStreetUsers` and `getGourmetStreetUsers` have no context byte, but
their stock AS3 handlers consume the returned placements as facade context.
Both responders therefore return only type-2 building placements; interior
items arrive later through `getUsers` context `4` (ADR-0016).

`swapIngredient` resolves only shipped ingredient hashes and applies both real
players' stock changes transactionally. Direct trades are **Friends-street
only**: the target must be on the caller's roster (hired employee or explicit
friendship), mirroring the client, which hides the trade button for street
visits. Direct trades also enforce the client rarity and unlocked-target rules
for real players **and** NPCs. Secure accepts must match a live type-6 mail
sent by the target to the caller (the sender's proposal + the recipient's
accept are the consent); the same rarity/stock/lock checks apply to the
NPC auto-accept path so a crafted request cannot mint ingredients an NPC does
not hold. Mail consumption, both stock changes, and the type-8 confirmation
commit together. Invalid, stale, replayed, understocked, or unauthorized
trades return existing status `4` without changing RPC 17's one-byte response
body (ADR-0024, ADR-0042).

Every ingredient a player **receives** — mail gift, daily bonus, quiz reward,
harvest, market/cash purchase, first-visit gift, social-link escrow, and
trade — is stored **locked** (`isLocked = true`) and must be manually unlocked
(lock icon, saveProfile action 9) before it can be traded away. Starter
ingredients for new profiles and NPC seeds stay unlocked (ADR-0042).

`getAllFriends` includes the active player first, followed only by distinct,
enabled account-backed profiles currently present in the owner's employee
rows. The Flash client needs the self entry to substitute its canonical
`GameWorld.gameUser`, render the owner's street building, and enable building
decoration. This response is the exact Your Street roster.

Random Street selects a fresh shuffled set of at most 10 enabled accounts after
excluding the owner and employee/friend UIDs. Gourmet Street returns at most 10
other enabled players with level ≥10 and gourmet points ≥100,000.
`getHireCandidates` independently returns up to 50 freshly shuffled non-hired
players for the patched SWF Hire loader. See ADR-0017.

When a full profile contains a garden ingredient that is unknown or has no
`plantClassName` in `public/data/ingredient.xml`, the responder writes the
existing empty-plot sentinel `0`. This keeps legacy/corrupt profiles visitable
without changing their stored database rows. See ADR-0018.

Unimplemented message types return an empty body, which the client treats as a
failed call.

## Notes

- Newsletter images are ordinary static-file requests. If the PNG isn't present
  the dashboard logs the 404 rather than returning a placeholder.
- `dev.db`, `dist/`, and `node_modules/` are gitignored — the database is
  recreated by `db:push` and the build by `npm start`.
