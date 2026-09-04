// Wire types for the admin dashboard API. Mirrors server/src/db/admin-store.ts
// inputs and server/src/http-server.ts responses (keep in sync with those).

export interface ApiEnvelope<T> {
  ok: true;
  [key: string]: unknown;
}

// ---------- session ----------
export interface SessionAccount {
  readonly username: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly networkUid: string;
}
export interface SessionResponse {
  ok: true;
  loggedIn: boolean;
  account?: SessionAccount;
  csrfToken?: string;
}
export interface ImpersonationResponse {
  ok: true;
  account: SessionAccount;
  expiresAt: string;
  url: string;
}

// ---------- overview / assets ----------
export interface OnlineUser {
  readonly username: string;
  readonly networkUid: string;
  readonly playfishUid: number;
  readonly lastSeenUnix: number;
  readonly pendingEvents: number;
  readonly inflightEvents: number;
}
export interface OverviewResponse {
  ok: true;
  staticFiles: number;
  servesRebuiltGameSwf: boolean;
  requestBuffer: number;
  maxLogEntries: number;
  rpcCount: number;
  notFoundCount: number;
  onlineUsers: OnlineUser[];
  uptimeSeconds: number;
  dbSizeBytes: number;
  serverTime: string;
  performance: {
    uptimeSeconds: number;
    memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
    eventLoopDelayMs: { p50: number; p95: number; p99: number; max: number };
    requestCount: number;
    requestLatency: { count: number; averageMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
    rpcCount: number;
    activeRequests: number;
    activityQueueSize: number;
    rpcLatency: Readonly<Record<string, { count: number; averageMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number }>>;
    jobs: Readonly<Record<string, { running: boolean; runs: number; skippedOverlaps: number; lastStartedAt: string | null; lastCompletedAt: string | null; lastDurationMs: number | null; lastError: string }>>;
  };
}
export interface AssetEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}
export interface AssetsResponse {
  ok: true;
  files: AssetEntry[];
  servesRebuiltGameSwf: boolean;
}

// ---------- traffic ----------
export interface RpcSubSummary {
  readonly name: string;
  readonly answered: string;
}
export interface RpcSummary {
  readonly call: string;
  readonly subs?: RpcSubSummary[];
  answered?: string;
  error?: string;
}
export interface CapturedRequest {
  id: number;
  time: string;
  method?: string;
  path: string;
  rawUrl?: string;
  query?: Record<string, string>;
  bodyLen: number;
  bodyText?: string;
  kind: 'http' | 'rpc';
  matched: string | null;
  status: number;
  respLen?: number;
  respHex?: string;
  durationMs: number;
  rpc?: RpcSummary;
  account?: { username: string; networkUid: string } | null;
}
export interface ClearResponse {
  ok: true;
}
export interface ReindexResponse {
  ok: true;
  files: number;
}

// ---------- catalog ----------
export interface ItemCatalogEntry {
  readonly id: number;
  readonly label: string;
  readonly category: string;
}
export interface CatalogResponse {
  ok: true;
  items: ItemCatalogEntry[];
}

// ---------- users ----------
export interface OwnedItem {
  id: string;
  serverId: number;
  globalItemId: number;
  positionX: number;
  positionY: number;
  data: number;
  roomIndex: number;
  employeeNetwork: number;
  employeeNetworkUid: string;
  employeePlayfishUid: number;
}
export interface InventoryItem {
  id: string;
  globalItemId: number;
  number: number;
  isSelected: boolean;
}
export interface IngredientInv {
  id: string;
  globalItemId: number;
  number: number;
  isLocked: boolean;
}
export interface GardenPlot {
  id: string;
  plotId: number;
  ingredientId: number;
  plantWetTime: number;
  timeToDry: number;
}
export interface RestaurantFloor {
  id: string;
  floorIndex: number;
  tilesJson: string;
}
export interface Employee {
  id: string;
  network: number;
  networkUid: string;
  playfishUid: number;
  happiness: number;
  task: number;
  notify: boolean;
}
export interface Mail {
  id: number;
  senderNetworkUid: string;
  recipientNetworkUid: string;
  globalItemIdsJson: string;
  itemId: number;
  message: string;
  read: boolean;
  deleted: boolean;
  sendDate: number;
  deleteTime: number;
  type: number;
}
export interface GameEvent {
  id: number;
  eventType: number;
  eventText: string;
  createdAtUnix: number;
}
export interface StoredImage {
  id: number;
  imageType: number;
  width: number;
  height: number;
  createdAt: string;
}
export interface AdminUser {
  id: string;
  network: number;
  networkUid: string;
  playfishUid: number;
  firstName: string;
  fullName: string;
  restaurantName: string;
  imageUrl: string;
  largeImageUrl: string;
  gender: number;
  credits: number;
  playCount: number;
  userLevel: number;
  gourmetPoint: number;
  nbVote: number;
  totalMark: number;
  trashPoint: number;
  demandPoint: number;
  musicPlay: number;
  cashBalance: number;
  bookmarkCount: number;
  isInStreet: boolean;
  activeFloorIndex: number;
  saveVersion: number;
  lastSave: number;
  lastSurveyTime: number;
  consecutionCount: number;
  createdAt: string;
  updatedAt: string;
  ownedItems: OwnedItem[];
  inventoryItems: InventoryItem[];
  ingredients: IngredientInv[];
  gardenPlots: GardenPlot[];
  floors: RestaurantFloor[];
  employees: Employee[];
  mailsSent: Mail[];
  mailsReceived: Mail[];
  visits: ReadonlyArray<Record<string, unknown>>;
  visitCredits: ReadonlyArray<Record<string, unknown>>;
  rankingsGiven: ReadonlyArray<Record<string, unknown>>;
  rankingsReceived: ReadonlyArray<Record<string, unknown>>;
  gameEvents: GameEvent[];
  storedImages: StoredImage[];
  notificationsSent: ReadonlyArray<Record<string, unknown>>;
  notificationsReceived: ReadonlyArray<Record<string, unknown>>;
  cashTransactions: ReadonlyArray<{ id: number; amount: number; createdAtUnix: number }>;
}
export interface AdminUserSummary {
  id: string;
  network: number;
  networkUid: string;
  playfishUid: number;
  firstName: string;
  fullName: string;
  restaurantName: string;
  gender: number;
  credits: number;
  cashBalance: number;
  playCount: number;
  userLevel: number;
  gourmetPoint: number;
  lastSave: number;
  updatedAt: string;
}
export interface UsersResponse {
  ok: true;
  users: AdminUserSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface UserOptionsResponse {
  ok: true;
  users: Array<{ networkUid: string; firstName: string; fullName: string }>;
}
export interface UserMutationResponse {
  ok: true;
  user: AdminUser;
}

// ---------- inputs (mirror admin-store validation) ----------
export interface ProfileInput {
  networkUid: string;
  playfishUid?: number;
  firstName: string;
  fullName: string;
  restaurantName: string;
  imageUrl?: string;
  largeImageUrl?: string;
  gender: number;
  credits: number;
  cashBalance?: number;
  playCount?: number;
  userLevel: number;
  gourmetPoint: number;
  nbVote?: number;
  totalMark?: number;
  trashPoint: number;
  demandPoint: number;
  musicPlay: number;
  bookmarkCount?: number;
  activeFloorIndex: number;
  isInStreet: boolean;
  saveVersion?: number;
  lastSave?: number;
  lastSurveyTime?: number;
  consecutionCount?: number;
}
export interface OwnedItemInput {
  globalItemId: number;
  positionX: number;
  positionY: number;
  data: number;
  roomIndex: number;
  employeeNetwork?: number;
  employeeNetworkUid?: string;
  employeePlayfishUid?: number;
}
export interface InventoryInput {
  globalItemId: number;
  number: number;
  isSelected?: boolean;
}
export interface IngredientInput {
  globalItemId: number;
  number: number;
  isLocked?: boolean;
}
export interface GardenPlotInput {
  plotId: number;
  ingredientId: number;
  plantWetTime: number;
  timeToDry: number;
}
export interface FloorInput {
  floorIndex: number;
  tilesJson: string | readonly number[];
}
export interface EmployeeInput {
  network?: number;
  networkUid: string;
  playfishUid?: number;
  happiness: number;
  task: number;
  notify?: boolean;
}
export interface MailInput {
  senderNetworkUid?: string;
  recipientNetworkUid?: string;
  globalItemIds?: readonly number[];
  itemId?: number;
  message?: string;
  read?: boolean;
  deleted?: boolean;
  sendDate?: number;
  deleteTime?: number;
  type?: number;
}
export interface GameEventInput {
  eventType: number;
  eventText: string;
  createdAtUnix?: number;
}

// ---------- economy ----------
export interface Pricepoint {
  id: number;
  productType: number;
  payoutParameter: number;
  paymentProvider: number;
  price: number;
  currency: string;
  currencyScale: number;
  clientData: string;
  token: string;
  enabled: boolean;
}
export interface PurchasableItem {
  id: number;
  skuId: number;
  price: number;
  currency: string;
  token: string;
  enabled: boolean;
}
export interface IngredientMarketItem {
  id: number;
  ingredientId: number;
  price: number;
  enabled: boolean;
}
export interface EconomyResponse {
  ok: true;
  economy: {
    pricepoints: Pricepoint[];
    purchasableItems: PurchasableItem[];
    ingredientMarketItems: IngredientMarketItem[];
  };
}
export interface PricepointInput {
  productType: number;
  payoutParameter: number;
  paymentProvider: number;
  price: number;
  currency: string;
  currencyScale: number;
  clientData?: string;
  token: string;
  enabled?: boolean;
}
export interface PurchasableItemInput {
  skuId: number;
  price: number;
  currency: string;
  token: string;
  enabled?: boolean;
}
export interface IngredientMarketInput {
  ingredientId: number;
  price: number;
  enabled?: boolean;
}
export interface EconomyItemResponse {
  ok: true;
  item: Pricepoint | PurchasableItem | IngredientMarketItem;
}

// ---------- live ----------
export interface OnlineResponse {
  ok: true;
  users: OnlineUser[];
}
export interface AlertResponse {
  ok: true;
  delivered: number;
  users: OnlineUser[];
}
export interface BulkMailInput extends MailInput {
  scope: 'online' | 'everyone' | 'specific';
  recipientNetworkUids?: readonly string[];
}
export interface BulkMailResponse {
  ok: true;
  created: number;
  liveNotified: number;
  users: OnlineUser[];
}
export interface DailyIngredientSyncResponse {
  ok: true;
  utcDate: string;
  created: boolean;
  announced: boolean;
  alreadyComplete: boolean;
  attemptCount: number;
  ingredients: ReadonlyArray<{ id: number; name: string; price: number }>;
}

// ---------- moderation / anomalies ----------
export interface AnomalyFinding {
  id: string; networkUid: string; ruleId: string; severity: string; score: number;
  title: string; summary: string; evidenceJson: string; evidenceVersion: number;
  notifiedVersion: number; status: string; occurrenceCount: number;
  firstSeenAt: string; lastSeenAt: string; resolvedAt?: string | null;
  reviewedAt?: string | null; reviewedByAccountId?: string | null; reviewNote: string;
}
export interface ModerationPlayerSummary {
  networkUid: string;
  account: { id: string; networkUid: string; username: string; firstName: string; lastName: string; role: string; disabled: boolean; createdAt: string; lastLoginAt?: string | null; _count: { sessions: number } } | null;
  profile: { networkUid: string; restaurantName: string; userLevel: number; gourmetPoint: number; credits: number; cashBalance: number; updatedAt: string } | null;
  activity: { totalActiveSeconds: number; loginCount: number; requestCount: number; rpcCount: number; saveCount: number; firstSeenAt: string; lastSeenAt: string } | null;
  riskScore: number; highestSeverity: string; openFindings: number; findings: AnomalyFinding[];
}
export interface ModerationOverviewResponse {
  ok: true; players: ModerationPlayerSummary[]; onlineNetworkUids: string[];
  latestScan?: { id: number; startedAt: string; completedAt?: string | null; profilesScanned: number; findingsCreated: number; findingsUpdated: number; findingsResolved: number; discordAttempted: boolean; discordSent: boolean; discordError: string } | null;
}
export interface ProfileSnapshotSummary {
  id: string; reason: string; label: string; payloadVersion: number; payloadDigest: string;
  userLevel: number; gourmetPoint: number; credits: number; cashBalance: number;
  placedItems: number; inventoryUnits: number; ingredientUnits: number; employeeCount: number;
  createdByAccountId?: string | null; createdAt: string;
}
export interface ProfileSaveFact {
  id: number; saveVersion: number; clientTime: number; serverDeltaSeconds: number; clientDeltaSeconds: number;
  previousCredits: number; credits: number; creditDelta: number; previousGourmet: number; gourmetPoint: number; gourmetDelta: number;
  previousLevel: number; userLevel: number; actionCount: number; unknownActionCount: number; actionCountsJson: string;
  placedItems: number; inventoryUnits: number; ingredientUnits: number; employeeCount: number; gardenPlotCount: number; selectedRecipeCount: number; createdAt: string;
}
export interface ModerationAction {
  id: string; actorUsername: string; actionType: string; reason: string; snapshotId?: string | null; detailsJson: string; createdAt: string;
}
export interface ModerationPlayerDetail extends ModerationPlayerSummary {
  online: boolean; snapshots: ProfileSnapshotSummary[]; saves: ProfileSaveFact[]; actions: ModerationAction[];
}
