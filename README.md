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

`npm start` builds the TypeScript project first, then runs `dist/server.js`.

Default URL: <http://localhost:8090>  
Dashboard: <http://localhost:8090/__dash>

## Useful commands

```bat
npm run check
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
| `src/rpc/codec.ts` | PlayFish binary RPC primitive readers/writers |
| `src/rpc/responders.ts` | implemented RPC response bodies |
| `src/rpc/index.ts` | request parsing and batch/single response envelopes |
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
| 20 | `getMails` |
| 40 | `purchaseCoinsWithPfCash` |
| 41 | `purchaseCashItem` |
| 42 | `purchaseCashItemIngredients` |
| 44 | `readBookmarkCount` |
| 45 | `writeBookmarkCount` |
| 46 | `sendNotification` |
| 246 | `getPricepoints` |
| 248 | `getCashBalance` |
| 249 | `getServerTime` |
| 250 | `getPurchasableItems` |
| 251 | `recordGameEvent` |
| 254 | `ping` |

`getUserProfile` returns a synthetic starter profile that mirrors the local
debug fallback user, plus three ingredient market entries. Autosaves are
acknowledged with the requested save version and empty mail/ingredient/garden
delta lists.

The newsletter image requests observed as `/news0.png`, `/news1.png`, and
`/news2.png` are served as generated transparent PNG placeholders.

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
