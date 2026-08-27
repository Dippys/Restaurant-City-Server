import type { ActiveAccount } from './session';

export const LIVE_EVENT_ALERT = 1;
export const LIVE_EVENT_MAIL = 2;

export interface LiveEvent {
  readonly id: number;
  readonly type: number;
  readonly body: Buffer;
}

export interface OnlineUser {
  readonly username: string;
  readonly networkUid: string;
  readonly playfishUid: number;
  readonly lastSeenUnix: number;
  readonly pendingEvents: number;
  readonly inflightEvents: number;
}

interface UserEvents {
  readonly account: ActiveAccount;
  lastSeenMs: number;
  readonly queued: LiveEvent[];
  readonly inflight: Map<number, LiveEvent>;
}

const ONLINE_TTL_MS = 45_000;
const MAX_EVENTS_PER_POLL = 10;

let nextEventId = 1;
const users = new Map<string, UserEvents>();

export function touchOnline(account: ActiveAccount): void {
  const existing = users.get(account.networkUid);
  if (existing) {
    existing.lastSeenMs = Date.now();
    return;
  }

  users.set(account.networkUid, {
    account,
    lastSeenMs: Date.now(),
    queued: [],
    inflight: new Map(),
  });
}

export function listOnlineUsers(): OnlineUser[] {
  pruneOfflineUsers();
  return [...users.values()]
    .sort((a, b) => a.account.username.localeCompare(b.account.username))
    .map((entry) => ({
      ...entry.account,
      lastSeenUnix: Math.floor(entry.lastSeenMs / 1000),
      pendingEvents: entry.queued.length,
      inflightEvents: entry.inflight.size,
    }));
}

export function pollLiveEvents(account: ActiveAccount, ackEventIds: readonly number[]): LiveEvent[] {
  touchOnline(account);
  const entry = users.get(account.networkUid);
  if (!entry) {
    return [];
  }

  for (const id of ackEventIds) {
    entry.inflight.delete(id);
  }

  while (entry.queued.length > 0 && entry.inflight.size < MAX_EVENTS_PER_POLL) {
    const event = entry.queued.shift();
    if (event) {
      entry.inflight.set(event.id, event);
    }
  }

  return [...entry.inflight.values()].slice(0, MAX_EVENTS_PER_POLL);
}

export function enqueueLiveEvent(networkUid: string, type: number, body: Buffer): boolean {
  pruneOfflineUsers();
  const entry = users.get(networkUid);
  if (!entry) {
    return false;
  }

  entry.queued.push({
    id: nextEventId++,
    type,
    body,
  });
  return true;
}

export function enqueueGlobalLiveEvent(type: number, body: Buffer): number {
  pruneOfflineUsers();
  let count = 0;
  for (const networkUid of users.keys()) {
    if (enqueueLiveEvent(networkUid, type, body)) {
      count += 1;
    }
  }
  return count;
}

/** Notify an online client that its authoritative mailbox changed. */
export function enqueueLiveMail(networkUid: string, mailType: number): boolean {
  pruneOfflineUsers();
  const entry = users.get(networkUid);
  if (!entry) return false;

  // One getMails response contains the whole authoritative inbox, so collapse
  // queued changes. Preserve a popup-producing type when any queued mail needs it.
  const queued = entry.queued.find((event) => event.type === LIVE_EVENT_MAIL);
  if (queued) {
    if (mailNeedsStartupPopup(mailType) || !mailNeedsStartupPopup(queued.body[0] ?? 0)) {
      queued.body[0] = mailType & 0xff;
    }
    return true;
  }
  return enqueueLiveEvent(networkUid, LIVE_EVENT_MAIL, Buffer.from([mailType & 0xff]));
}

function mailNeedsStartupPopup(mailType: number): boolean {
  return mailType === 5 || mailType === 10 || mailType === 11 || mailType === 13;
}

function pruneOfflineUsers(): void {
  const cutoff = Date.now() - ONLINE_TTL_MS;
  for (const [networkUid, entry] of users) {
    if (entry.lastSeenMs < cutoff) {
      users.delete(networkUid);
    }
  }
}
