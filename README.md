# Restaurant City local server

Typed local backend, static asset server, request capture dashboard, and binary
RPC responder for the Restaurant City Flash client.

## Run it

```bat
start.bat
```

or:

```bat
npm start
```

`npm start` syncs the SQLite schema, builds the TypeScript project, then runs
`dist/server.js`.

Default URL: <http://localhost:8090>  
Dashboard: <http://localhost:8090/__dash>
Game page: <http://localhost:8090/game>  
Database admin: <http://localhost:8090/admin>

## Useful commands

```bat
npm run check
npm run db:push
npm run build
npm run start:built
```

Use `npm run start:built` only after `npm run build`.

## Layout

| Path | Purpose |
|---|---|
| `src/server.ts` | process entrypoint and startup banner |
| `src/http-server.ts` | HTTP routes, dashboard API, static serving, RPC endpoint |
| `src/static-files.ts` | fuzzy asset index for RC root and `bin-xml` |
| `src/request-log.ts` | in-memory request ring buffer and SSE fan-out |
| `src/db/` | Prisma client and database-backed profile store |
| `src/rpc/codec.ts` | PlayFish binary RPC primitive readers/writers |
| `src/rpc/save-profile-parser.ts` | decoder for `saveProfile` profile/audit payloads |
| `src/rpc/responders.ts` | implemented RPC response bodies |
| `src/rpc/index.ts` | request parsing and batch/single response envelopes |
| `prisma/schema.prisma` | SQLite persistence schema |
| `prisma.config.ts` | Prisma 7 datasource config |
| `server.js` | compatibility shim; run `npm start` if `dist/` is missing |

## RPC status

Implemented responders:

| msgType | call |
|---:|---|
| 1 | `init` |
| 2 | `getAllFriends` |
| 3 | `getUserProfile` |
| 4 | `getUsers` |
| 5 | `saveProfile` |
| 17 | `swapIngredient` |
| 19 | `sendMail` |
| 20 | `getMails` |
| 25 | `quizzReply` |
| 32 | `buyMystryBox` |
| 34 | `storeImage` |
| 35 | `rankRestaurant` |
| 36 | `firstTimeVisitFriend` |
| 37 | `getRandomStreetUsers` |
| 38 | `getGourmetStreetUsers` |
| 40 | `purchaseCoinsWithPfCash` |
| 41 | `purchaseCashItem` |
| 42 | `purchaseCashItemIngredients` |
| 43 | `waterFriendGarden` |
| 44 | `readBookmarkCount` |
| 45 | `writeBookmarkCount` |
| 46 | `sendNotification` |
| 246 | `getPricepoints` |
| 247 | `pollEvents` |
| 248 | `getCashBalance` |
| 249 | `getServerTime` |
| 250 | `getPurchasableItems` |
| 251 | `recordGameEvent` |
| 253 | `getTimeToken0` |
| 254 | `ping` |

SQLite now stores profile state, owned items, inventory, ingredients, garden
plots, floors, employees, mails, bookmark count, cash balance and transactions,
pricepoints, purchasable items, restaurant ranks, notifications, game events,
visit rewards, and stored images. `saveProfile` applies the decoded PlayFish
audit-change payload to those tables.

Newsletter image requests are normal static-file requests. If a real newsletter
PNG is not present, the dashboard logs the 404 instead of returning a generated
placeholder.

## Control endpoints

| Route | Purpose |
|---|---|
| `/__dash` | live dashboard UI |
| `/__events` | SSE stream of captured requests |
| `/__api/requests` | JSON snapshot of the capture buffer |
| `/__api/clear` | clear the capture buffer |
| `/__api/reindex` | rescan static files |
| `/crossdomain.xml` | permissive Flash policy |

## Notes

- Static serving still prefers `../decompiled/game/bin/game.swf` over the
  original root `game.swf`.
- Asset matching still strips browser download suffixes like `[1]`, so
  `/lang_en.bin` resolves to `bin-xml/lang_en[1].bin`.
- The client must be loaded from this server for relative asset URLs to resolve
  here. Use `play.bat`.
