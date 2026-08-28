# ADR-0042: Eliminate owned-item duplication — delivery-only renumbering, save reconciliation, phantom cleanup

Status: accepted · Date: 2026-08-28

## Context

Production players accumulate **duplicated furniture**: the same item exists
multiple times at one tile (stoves on top of each other, three Koi Ponds on
one spot, a pinball machine ×3 at each of ~15 positions). The prod DB shows
1,094 exact-position duplicate groups across profiles, and the count grows
with every play session. The player reports two triggers: buying Playfish-Cash
items, and buying → placing → moving/rotating → saving.

Root cause: `getPlayerProfile()` runs `prepareOwnedItemsForProfileDelivery()`,
which renumbers the client's negative local serverIds (`UserItem.nextLocalUid`
restarts at −1 each SWF load) to positive ids **on every call**. That profile
fetch is reached from many RPC paths whose responses never carry the owner's
profile back to the client — Random/Gourmet Street (37/38), hire candidates
(39), every cash purchase (41/42 via `ensureAccountProfile`), mail (19),
trades (17), `initSession`/`cashBalance`. The live client keeps holding its
items under the original negative uids; its next save (move/rotate/autosave at
60 s) upserts by `(userProfileId, serverId)` → the renumbered row is gone →
`ownedItem.upsert` **creates a second row** for the same physical item. The
next internal read renumbers the new negative row again, and the next save
creates yet another copy — compounding every session. Cash purchases are the
worst trigger because RPC 41 itself renumbers immediately before the client
places the item and saves.

A secondary symptom the player noticed: `CLIENT_TIME_REVERSED` anomaly
findings. `recordAcceptedSaveTx` decides "same session" from
`saveVersion > previous.saveVersion`, but the fence restarts saveVersion at 1
per SWF load, so two saves from *different* SWF instances can compare client
clocks (each instance starts `getTimer()` at 0) and look like a reversed
clock. That rule noise is unrelated to the duplication mechanism but shares
the same "reload/session" confusion.

## Decision

1. **Renumber only when the client actually receives the new ids.** New
   read-only `readOwnerProfile(account)` (no delivery preparation). All
   internal callers — `streetUsers`, `gourmetStreetUsers`, `hireCandidates`,
   `ensureAccountProfile` (cash purchases, mail, trades, init, balance),
   `ensureProfileByUid`, `ensureLoginAccount` — use it. Only the
   `getUserProfile` responder keeps `getPlayerProfile`, whose renumbering is
   then immediately consumed by the client (`UserItem.setOwnedItem` adopts the
   delivered serverIds). The client's subsequent saves always hit an existing
   row, so the create-duplicate loop cannot start.
2. **Save-time reconciliation (defense in depth).** In `savePlayerProfile`, an
   upsert item with a **negative** serverId that has no row means the row was
   renumbered by an earlier delivery. Before creating, look for the physical
   twin — same `(globalItemId, positionX, positionY, roomIndex)`, newest
   first — and **update that row in place** (keeping its positive id) instead
   of creating a new one. Excluded: items whose `type` contains `stackable`
   (Crate/Sake Keg/Barrel — legitimate stacks share a tile), items in
   `wallDecorationItem` groups (walls legitimately hold several decorations at
   one position), and façade singleton groups (201/202/205/206/207, already
   handled by their own dedup).
3. **Delivery-time phantom cleanup.** In `prepareOwnedItemsForProfileDelivery`,
   after renumbering: for every `(globalItemId, positionX, positionY,
   roomIndex)` group with more than one row (excluding stackable, wall, and
   façade items — two identical non-stackable items can never legitimately
   share a tile — and excluding non-restaurant ranges, because the avatar
   wardrobe (1xxxxxx) and building layers (2xxxxxx) legitimately pile rows at
   one position), keep the newest row and **delete** the phantoms. Deleting —
   not returning to inventory — is correct: a phantom was never purchased, so
   returning it would mint a free item.
4. **Exact session clock guard.** Add `rpcSessionToken` to `ProfileSaveFact`
   and compare facts only when both carry the same non-empty token (the fence
   issues one token per SWF load). `CLIENT_TIME_REVERSED` additionally ignores
   reversals under 15 s (timer noise). Reload artifacts stop flagging.
5. **Repair script.** `scripts/dedupe-owned-items.cjs` sweeps the existing prod
   DB with the same keep-newest/delete-phantom rule (report-only by default;
   `--apply` backs the SQLite file up first).
6. No wire, schema-field-removal, or AS3 change. (One additive column on
   `ProfileSaveFact`.)

## Consequences

- New duplicates stop forming: the create path for a stale negative uid now
  merges into its renumbered twin, and renumbering happens only at
  client-visible delivery.
- Existing stacked duplicates are removed automatically at the player's next
  profile load (delivery cleanup) and bulk-cleaned by the script.
- Stacked Crates/Barrels/Sake Kegs and wall-decoration layers are preserved.
- `CLIENT_TIME_REVERSED` only reports genuine same-instance reversals; reload
  noise disappears. Existing findings are historical and can be re-scanned.
- Position-change ghosts (a phantom left at the tile the item was moved from,
  created before this fix) are indistinguishable from a legitimately purchased
  second copy; they stop growing and remain playable (sellable) items rather
  than being auto-deleted.

## Evidence

- `test/owned-item-duplication.test.cjs` (new): read-only owner fetch does not
  renumber while the delivery fetch does; a save reusing a stale negative uid
  updates the twin instead of creating; stackable and wall items are exempt
  from reconciliation and cleanup; delivery deletes same-position phantoms and
  keeps the newest; the moderation clock rule compares within one session
  token and ignores sub-15 s noise.
- Prod DB analysis before the fix: 1,094 exact-position duplicate groups
  (e.g. `facebook:1015124476` — Koi Pond 3020123 ×3 at (4,5) across 22:13→22:28;
  `facebook:1098633897` — Pinball 3500080/Toilet 3500019 ×3 at ~15 positions
  over three days; `facebook:1162241384` — Crate 3020176 ×3 at ~12 positions,
  which the stackable exemption correctly preserves).
- `server/npm run check`/`build` green; full `server/npm test` suite green.
