import { prisma } from './client';

export type LeaderboardBoard = 'gourmet' | 'rated' | 'rising' | 'level' | 'favorites';
export type LeaderboardPeriod = 'week' | 'month' | 'all';
export type LeaderboardCacheStatus = 'HIT' | 'MISS' | 'COALESCED' | 'STALE';

export interface LeaderboardProfile {
  readonly networkUid: string;
  readonly username: string;
  readonly restaurantName: string;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly nbVote: number;
  readonly totalMark: number;
  readonly bookmarkCount: number;
  readonly createdAt: Date;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly movement: number | null;
  readonly networkUid: string;
  readonly username: string;
  readonly restaurantName: string;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly rating: number | null;
  readonly voteCount: number;
  readonly bookmarkCount: number;
  readonly gourmetGain: number;
  readonly score: number;
  readonly joinedAt: string;
}

interface CacheState<T> {
  value?: T;
  expiresAt: number;
  pending?: Promise<T>;
}

/** Small in-process TTL cache with one in-flight loader per key and stale-on-error fallback. */
export class TtlSingleFlightCache<T> {
  private readonly states = new Map<string, CacheState<T>>();

  peek(key: string): T | undefined {
    return this.states.get(key)?.value;
  }

  clear(): void {
    this.states.clear();
  }

  async get(key: string, ttlMs: number, loader: () => Promise<T>, now = Date.now()): Promise<{ value: T; status: LeaderboardCacheStatus }> {
    const current = this.states.get(key);
    if (current?.value !== undefined && current.expiresAt > now) return { value: current.value, status: 'HIT' };
    if (current?.pending) return { value: await current.pending, status: 'COALESCED' };

    const state = current ?? { expiresAt: 0 };
    const pending = loader();
    state.pending = pending;
    this.states.set(key, state);
    try {
      const value = await pending;
      state.value = value;
      state.expiresAt = Date.now() + Math.max(1_000, ttlMs);
      state.pending = undefined;
      return { value, status: 'MISS' };
    } catch (error) {
      state.pending = undefined;
      if (state.value !== undefined) {
        state.expiresAt = Date.now() + Math.min(15_000, Math.max(1_000, ttlMs));
        return { value: state.value, status: 'STALE' };
      }
      this.states.delete(key);
      throw error;
    }
  }
}

interface LeaderboardSnapshot {
  readonly board: LeaderboardBoard;
  readonly period: LeaderboardPeriod;
  readonly generatedAt: string;
  readonly entries: readonly LeaderboardEntry[];
}

export interface LeaderboardPage {
  readonly board: LeaderboardBoard;
  readonly period: LeaderboardPeriod;
  readonly generatedAt: string;
  readonly cache: LeaderboardCacheStatus;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
  readonly query: string;
  readonly podium: readonly LeaderboardEntry[];
  readonly entries: readonly LeaderboardEntry[];
  readonly viewer: LeaderboardEntry | null;
}

const cache = new TtlSingleFlightCache<LeaderboardSnapshot>();
const profileCache = new TtlSingleFlightCache<readonly LeaderboardProfile[]>();

export async function leaderboardPage(
  params: URLSearchParams,
  viewerNetworkUid: string | undefined,
  ttlMs: number,
): Promise<LeaderboardPage> {
  const board = parseBoard(params.get('board'));
  const period = board === 'rising' ? parsePeriod(params.get('period')) : 'all';
  const page = boundedInt(params.get('page'), 1, 100_000, 1);
  const pageSize = boundedInt(params.get('pageSize'), 5, 50, 25);
  const query = cleanSearch(params.get('q'));
  const key = `${board}:${period}`;
  const previous = cache.peek(key);
  const result = await cache.get(key, ttlMs, () => loadSnapshot(board, period, previous, ttlMs));
  const allEntries = result.value.entries;
  const matching = query
    ? allEntries.filter((entry) => `${entry.username}\n${entry.restaurantName}`.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US')))
    : allEntries;
  const totalPages = Math.max(1, Math.ceil(matching.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  return {
    board,
    period,
    generatedAt: result.value.generatedAt,
    cache: result.status,
    page: safePage,
    pageSize,
    total: matching.length,
    totalPages,
    query,
    podium: allEntries.slice(0, 3),
    entries: matching.slice(offset, offset + pageSize),
    viewer: viewerNetworkUid ? allEntries.find((entry) => entry.networkUid === viewerNetworkUid) ?? null : null,
  };
}

export function buildLeaderboardEntries(
  profiles: readonly LeaderboardProfile[],
  gains: ReadonlyMap<string, number>,
  board: LeaderboardBoard,
  previousRanks: ReadonlyMap<string, number> = new Map(),
): LeaderboardEntry[] {
  const ratingPool = profiles.filter((profile) => profile.nbVote >= 5 && profile.totalMark > 0);
  const ratingVotes = ratingPool.reduce((sum, profile) => sum + profile.nbVote, 0);
  const ratingMarks = ratingPool.reduce((sum, profile) => sum + profile.totalMark, 0);
  const communityMean = ratingVotes > 0 ? ratingMarks / ratingVotes : 3;

  const eligible = board === 'rated'
    ? ratingPool
    : board === 'rising'
      ? profiles.filter((profile) => (gains.get(profile.networkUid) ?? 0) > 0)
      : profiles;

  const scored = eligible.map((profile) => {
    const rating = profile.nbVote > 0 ? profile.totalMark / profile.nbVote : null;
    const gourmetGain = gains.get(profile.networkUid) ?? 0;
    let score = profile.gourmetPoint;
    if (board === 'rated') score = ((profile.totalMark) + (communityMean * 10)) / (profile.nbVote + 10);
    if (board === 'rising') score = gourmetGain;
    if (board === 'level') score = profile.userLevel;
    if (board === 'favorites') score = profile.bookmarkCount;
    return { profile, rating, gourmetGain, score };
  });

  scored.sort((left, right) =>
    right.score - left.score
    || (board === 'rated' ? right.profile.nbVote - left.profile.nbVote : 0)
    || (board === 'level' ? right.profile.gourmetPoint - left.profile.gourmetPoint : 0)
    || right.profile.gourmetPoint - left.profile.gourmetPoint
    || left.profile.username.localeCompare(right.profile.username, 'en-US', { sensitivity: 'base' }),
  );

  return scored.map(({ profile, rating, gourmetGain, score }, index) => {
    const rank = index + 1;
    const previousRank = previousRanks.get(profile.networkUid);
    return {
      rank,
      movement: previousRank === undefined ? null : previousRank - rank,
      networkUid: profile.networkUid,
      username: profile.username,
      restaurantName: profile.restaurantName,
      userLevel: profile.userLevel,
      gourmetPoint: profile.gourmetPoint,
      rating: rating === null ? null : round(rating, 2),
      voteCount: profile.nbVote,
      bookmarkCount: profile.bookmarkCount,
      gourmetGain,
      score: round(score, board === 'rated' ? 3 : 0),
      joinedAt: profile.createdAt.toISOString(),
    };
  });
}

async function loadSnapshot(
  board: LeaderboardBoard,
  period: LeaderboardPeriod,
  previous: LeaderboardSnapshot | undefined,
  ttlMs: number,
): Promise<LeaderboardSnapshot> {
  const publicProfiles = (await profileCache.get('eligible-profiles', ttlMs, loadPublicProfiles)).value;
  const gains = board === 'rising' ? await loadGourmetGains(period) : new Map<string, number>();
  const previousRanks = new Map(previous?.entries.map((entry) => [entry.networkUid, entry.rank]) ?? []);
  return {
    board,
    period,
    generatedAt: new Date().toISOString(),
    entries: buildLeaderboardEntries(publicProfiles, gains, board, previousRanks),
  };
}

async function loadPublicProfiles(): Promise<readonly LeaderboardProfile[]> {
  const [profiles, accounts, excludedFindings] = await Promise.all([
    prisma.userProfile.findMany({ select: {
      networkUid: true, restaurantName: true, userLevel: true, gourmetPoint: true,
      nbVote: true, totalMark: true, bookmarkCount: true, createdAt: true,
    } }),
    prisma.account.findMany({ where: { disabled: false }, select: { networkUid: true, username: true } }),
    prisma.anomalyFinding.findMany({
      where: { status: 'OPEN', severity: 'CRITICAL' },
      distinct: ['networkUid'],
      select: { networkUid: true },
    }),
  ]);
  const accountsByUid = new Map(accounts.map((account) => [account.networkUid, account.username]));
  const excluded = new Set(excludedFindings.map((finding) => finding.networkUid));
  return profiles.flatMap((profile) => {
    const username = accountsByUid.get(profile.networkUid);
    if (!username || excluded.has(profile.networkUid)) return [];
    return [{ ...profile, username }];
  });
}

async function loadGourmetGains(period: LeaderboardPeriod): Promise<Map<string, number>> {
  const since = periodStart(period);
  const rows = await prisma.profileSaveFact.groupBy({
    by: ['networkUid'],
    where: {
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    _sum: { gourmetDelta: true },
  });
  return new Map(rows.map((row) => [row.networkUid, row._sum.gourmetDelta ?? 0]));
}

function periodStart(period: LeaderboardPeriod): Date | null {
  if (period === 'all') return null;
  const days = period === 'week' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
}

function parseBoard(value: string | null): LeaderboardBoard {
  return value === 'rated' || value === 'rising' || value === 'level' || value === 'favorites' ? value : 'gourmet';
}

function parsePeriod(value: string | null): LeaderboardPeriod {
  return value === 'month' || value === 'all' ? value : 'week';
}

function cleanSearch(value: string | null): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

function boundedInt(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
