// Typed fetch client for the admin API.
import type {
  AdminUser,
  AlertResponse,
  AssetsResponse,
  BulkMailInput,
  BulkMailResponse,
  CatalogResponse,
  CapturedRequest,
  ClearResponse,
  EconomyItemResponse,
  EconomyResponse,
  FloorInput,
  GameEventInput,
  GardenPlotInput,
  IngredientInput,
  IngredientMarketInput,
  InventoryInput,
  MailInput,
  OnlineResponse,
  OverviewResponse,
  OwnedItemInput,
  PricepointInput,
  ProfileInput,
  PurchasableItemInput,
  ReindexResponse,
  SessionResponse,
  ImpersonationResponse,
  UserMutationResponse,
  UsersResponse,
  DailyIngredientSyncResponse,
  ModerationOverviewResponse,
  ModerationPlayerDetail,
  AnomalyFinding,
} from './types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = '';

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch (error) {
    throw new ApiError(0, error instanceof Error ? error.message : String(error));
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, `Invalid JSON response (HTTP ${res.status})`);
  }
  const record = data as { ok?: boolean; error?: string };
  if (!res.ok || record.ok === false) {
    throw new ApiError(res.status, record.error || `Request failed (HTTP ${res.status})`);
  }
  return data as T;
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

export const api = {
  // session / auth
  session: () => request<SessionResponse>('GET', '/__api/session'),
  logout: () => request<{ ok: true }>('POST', '/__api/logout'),
  impersonateUser: (uid: string) => request<ImpersonationResponse>('POST', '/__api/admin/impersonation', { networkUid: uid }),

  // server overview
  overview: () => request<OverviewResponse>('GET', '/__api/admin/overview'),
  assets: () => request<AssetsResponse>('GET', '/__api/admin/assets'),

  // traffic
  requests: () => request<CapturedRequest[]>('GET', '/__api/requests'),
  clearRequests: () => request<ClearResponse>('POST', '/__api/clear'),
  reindex: () => request<ReindexResponse>('POST', '/__api/reindex'),
  requestReset: () => request<{ ok: true }>('POST', '/__api/db/reset'),

  // catalog + users
  catalog: () => request<CatalogResponse>('GET', '/__api/db/catalog'),
  users: () => request<UsersResponse>('GET', '/__api/db/users'),
  createUser: (input: ProfileInput) => request<UserMutationResponse>('POST', '/__api/db/users', input),
  updateUser: (uid: string, input: ProfileInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}`, input),
  deleteUser: (uid: string) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}`),

  // user sub-resources (all return the refreshed user)
  addOwnedItem: (uid: string, input: OwnedItemInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/items`, input),
  updateOwnedItem: (uid: string, serverId: number, input: OwnedItemInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/items/${enc(serverId)}`, input),
  deleteOwnedItem: (uid: string, serverId: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/items/${enc(serverId)}`),

  addInventory: (uid: string, input: InventoryInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/inventory`, input),
  updateInventory: (uid: string, id: number, input: InventoryInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/inventory/${enc(id)}`, input),
  deleteInventory: (uid: string, id: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/inventory/${enc(id)}`),

  addIngredient: (uid: string, input: IngredientInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/ingredients`, input),
  updateIngredient: (uid: string, id: number, input: IngredientInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/ingredients/${enc(id)}`, input),
  deleteIngredient: (uid: string, id: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/ingredients/${enc(id)}`),

  addGardenPlot: (uid: string, input: GardenPlotInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/garden`, input),
  updateGardenPlot: (uid: string, id: number, input: GardenPlotInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/garden/${enc(id)}`, input),
  deleteGardenPlot: (uid: string, id: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/garden/${enc(id)}`),

  addFloor: (uid: string, input: FloorInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/floors`, input),
  updateFloor: (uid: string, id: number, input: FloorInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/floors/${enc(id)}`, input),
  deleteFloor: (uid: string, id: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/floors/${enc(id)}`),

  addEmployee: (uid: string, input: { networkUid: string; happiness: number; task: number; notify?: boolean; network?: number; playfishUid?: number }) =>
    request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/employees`, input),
  updateEmployee: (uid: string, employeeUid: string, input: EmployeeInputLike) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/employees/${enc(employeeUid)}`, input),
  deleteEmployee: (uid: string, employeeUid: string) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/employees/${enc(employeeUid)}`),

  addMail: (uid: string, input: MailInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/mails`, input),
  updateMail: (uid: string, mailId: number, input: MailInput) => request<UserMutationResponse>('PATCH', `/__api/db/users/${enc(uid)}/mails/${enc(mailId)}`, input),
  deleteMail: (uid: string, mailId: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/mails/${enc(mailId)}`),

  addGameEvent: (uid: string, input: GameEventInput) => request<UserMutationResponse>('POST', `/__api/db/users/${enc(uid)}/events`, input),
  deleteGameEvent: (uid: string, eventId: number) => request<UserMutationResponse>('DELETE', `/__api/db/users/${enc(uid)}/events/${enc(eventId)}`),

  // economy
  economy: () => request<EconomyResponse>('GET', '/__api/db/economy'),
  upsertPricepoint: (id: number | null, input: PricepointInput) =>
    request<EconomyItemResponse>(id === null ? 'POST' : 'PATCH', `/__api/db/economy/pricepoints${id === null ? '' : `/${id}`}`, input),
  deletePricepoint: (id: number) => request<{ ok: true }>('DELETE', `/__api/db/economy/pricepoints/${id}`),
  upsertPurchasableItem: (id: number | null, input: PurchasableItemInput) =>
    request<EconomyItemResponse>(id === null ? 'POST' : 'PATCH', `/__api/db/economy/purchasable-items${id === null ? '' : `/${id}`}`, input),
  deletePurchasableItem: (id: number) => request<{ ok: true }>('DELETE', `/__api/db/economy/purchasable-items/${id}`),
  upsertIngredientMarketItem: (id: number | null, input: IngredientMarketInput) =>
    request<EconomyItemResponse>(id === null ? 'POST' : 'PATCH', `/__api/db/economy/ingredient-market${id === null ? '' : `/${id}`}`, input),
  deleteIngredientMarketItem: (id: number) => request<{ ok: true }>('DELETE', `/__api/db/economy/ingredient-market/${id}`),

  // live
  online: () => request<OnlineResponse>('GET', '/__api/live/online'),
  alert: (input: { scope: string; networkUid?: string; title?: string; message: string }) => request<AlertResponse>('POST', '/__api/live/alert', input),
  sendMail: (input: BulkMailInput) => request<BulkMailResponse>('POST', '/__api/live/mail', input),
  forceDailyIngredientSync: () => request<DailyIngredientSyncResponse>('POST', '/__api/live/daily-ingredients/sync'),

  // moderation
  moderation: () => request<ModerationOverviewResponse>('GET', '/__api/moderation'),
  moderationPlayer: (uid: string) => request<{ ok: true; player: ModerationPlayerDetail }>('GET', `/__api/moderation/players/${enc(uid)}`),
  runModerationScan: () => request<{ ok: true; result: Record<string, number> }>('POST', '/__api/moderation/scan'),
  resetModerationFindings: () => request<{ ok: true; result: Record<string, number> }>('POST', '/__api/moderation/reset'),
  reviewFinding: (id: string, input: { status: string; note: string }) => request<{ ok: true; finding: AnomalyFinding }>('PATCH', `/__api/moderation/findings/${enc(id)}`, input),
  createModerationSnapshot: (uid: string, label: string) => request<{ ok: true; result: { snapshotId: string } }>('POST', `/__api/moderation/players/${enc(uid)}/snapshots`, { label }),
  rollbackPlayer: (uid: string, snapshotId: string, reason: string) => request<{ ok: true; result: Record<string, unknown> }>('POST', `/__api/moderation/players/${enc(uid)}/rollback`, { snapshotId, reason }),
  resetPlayer: (uid: string, reason: string) => request<{ ok: true; result: Record<string, unknown> }>('POST', `/__api/moderation/players/${enc(uid)}/reset`, { reason }),
  banPlayer: (uid: string, reason: string) => request<{ ok: true; result: Record<string, unknown> }>('POST', `/__api/moderation/players/${enc(uid)}/ban`, { reason }),
  unbanPlayer: (uid: string, reason: string) => request<{ ok: true; result: Record<string, unknown> }>('POST', `/__api/moderation/players/${enc(uid)}/unban`, { reason }),
  terminatePlayer: (uid: string, reason: string) => request<{ ok: true; result: Record<string, unknown> }>('POST', `/__api/moderation/players/${enc(uid)}/terminate`, { reason }),

  socialLinks: () => request<{ ok: true; links: SocialLinkAdmin[] }>('GET', '/__api/admin/social-links'),
  socialLink: (id: string) => request<{ ok: true; link: SocialLinkAdmin }>('GET', `/__api/admin/social-links/${enc(id)}`),
  createSocialLink: (input: Record<string, unknown>) => request<{ ok: true; id: string; slug: string; url: string }>('POST', '/__api/admin/social-links', input),
  patchSocialLink: (id: string, input: Record<string, unknown>) => request<{ ok: true; link: SocialLinkAdmin }>('PATCH', `/__api/admin/social-links/${enc(id)}`, input),
  socialLifecycle: (id: string, operation: 'activate' | 'pause' | 'resume' | 'revoke' | 'expire' | 'duplicate') => request<{ ok: true; link: SocialLinkAdmin }>('POST', `/__api/admin/social-links/${enc(id)}/${operation}`),
};

// Keep EmployeeInput available for the update path without importing types twice.
export type EmployeeInputLike = {
  networkUid: string;
  network?: number;
  playfishUid?: number;
  happiness: number;
  task: number;
  notify?: boolean;
};

export type { AdminUser };

export interface SocialLinkAdmin {
  id: string; slug: string; kind: string; status: string; title: string; description: string; imagePath: string;
  notBefore?: string | null; expiresAt?: string | null; totalActionLimit?: number | null; perAccountLimit: number;
  successfulActionCount: number; createdAt: string; updatedAt: string; actions?: Array<{ id: string; action: string; outcome: string; resultSummary: string; createdAt: string }>;
  _count?: { actions: number; escrows: number };
}
