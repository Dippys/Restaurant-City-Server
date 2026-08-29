// Spec: decompiled/game/scripts/com/playfish/games/cooking/GameWorld.as
// ADR-0034: explainable rules only; no rule performs punishment.
import { fullCatalog } from '../db/item-catalog';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RuleFinding {
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly score: number;
  readonly title: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ModerationProfile {
  readonly networkUid: string;
  readonly restaurantName?: string;
  readonly knownFallbackRecovery?: boolean;
  readonly credits: number;
  readonly cashBalance: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly activeFloorIndex: number;
  readonly createdAt: Date;
  readonly ownedItems: ReadonlyArray<{ globalItemId: number }>;
  readonly inventoryItems: ReadonlyArray<{ globalItemId: number; number: number; isSelected: boolean }>;
  readonly ingredients: ReadonlyArray<{ globalItemId: number; number: number }>;
  readonly gardenPlots: ReadonlyArray<{ ingredientId: number }>;
  readonly employees: ReadonlyArray<unknown>;
  readonly cashTransactions: ReadonlyArray<{ amount: number }>;
}

export interface ModerationActivityLike {
  readonly totalActiveSeconds: number;
  readonly loginCount: number;
  readonly requestCount: number;
  readonly saveCount: number;
}

export interface SaveFactLike {
  readonly creditDelta: number;
  readonly gourmetDelta: number;
  readonly clientDeltaSeconds: number;
  readonly serverDeltaSeconds: number;
  readonly actionCount: number;
  readonly unknownActionCount: number;
  readonly createdAt: Date;
}

// Exact points copied from GameWorld.LEVEL_THRESHOLDS (levels 0..68).
export const LEVEL_POINTS = [
  0, 50, 70, 100, 200, 500, 1000, 2000, 4000, 6000, 8000, 10000,
  14000, 18000, 22000, 30000, 38000, 46000, 58000, 70000, 86000,
  102000, 122000, 142000, 166000, 190000, 218000, 246000, 280000,
  320000, 370000, 430000, 500000, 580000, 661000, 743000, 826000,
  910000, 995000, 1081000, 1168000, 1256000, 1345000, 1435000,
  1526000, 1618000, 1711000, 1805000, 1900000, 1996000, 2093000,
  2191000, 2290000, 2390000, 2491000, 2593000, 2696000, 2800000,
  2905000, 3011000, 3118000, 3226000, 3335000, 3445000, 3556000,
  3668000,
] as const;

export function levelForGourmet(points: number): number {
  for (let level = LEVEL_POINTS.length - 1; level >= 0; level -= 1) {
    if (points >= LEVEL_POINTS[level]!) return level;
  }
  return 0;
}

export function unlocksForLevel(level: number): { employees: number; gardenPlots: number; layouts: number; numDishes: number } {
  const safe = Math.max(0, Math.min(LEVEL_POINTS.length - 1, Math.trunc(level)));
  const employees = safe >= 21 ? 9 : safe >= 17 ? 8 : safe >= 14 ? 7 : safe >= 11 ? 6 : safe >= 8 ? 5 : safe >= 5 ? 4 : safe >= 2 ? 3 : 2;
  const gardenPlots = safe >= 32 ? 9 : safe >= 30 ? 8 : safe >= 28 ? 7 : safe >= 26 ? 6 : safe >= 24 ? 5 : safe >= 22 ? 4 : safe >= 18 ? 3 : safe >= 13 ? 2 : safe >= 6 ? 1 : 0;
  return { employees, gardenPlots, layouts: safe >= 20 ? 3 : safe >= 10 ? 2 : 1, numDishes: safe >= 20 ? 3 : safe >= 10 ? 2 : 1 };
}

export function evaluateProfile(
  profile: ModerationProfile,
  activity: ModerationActivityLike | null,
  latestFact: SaveFactLike | null,
  now = new Date(),
): RuleFinding[] {
  const findings: RuleFinding[] = [];
  // UserInfo.gourmetPoint stores tenths. GameUser.getGourmetPoints() divides by
  // ten before GameWorld.getLevel(); the server's fresh-profile policy starts at
  // level 1 even while the stored total is zero.
  const expectedLevel = Math.max(1, levelForGourmet(Math.floor(profile.gourmetPoint / 10)));
  // Unlock surfaces read GameUser.level.value, not the level inferred from GP.
  // Keep their evidence tied to the persisted level and report the GP mismatch
  // separately so one damaged scalar does not cascade into false unlock flags.
  const unlocks = unlocksForLevel(profile.userLevel);
  // Activity is retained as operator context, but there is no progression
  // baseline from when measurement began. Lifetime totals cannot be divided by
  // this partial clock to produce a valid anomaly finding.
  void activity;
  void now;
  const isFallbackProfile = /^Dummy\d+$/i.test((profile.restaurantName ?? '').trim())
    && profile.userLevel === 11 && profile.gourmetPoint === 10_000;
  const fallbackState = isFallbackProfile || Boolean(profile.knownFallbackRecovery);

  if (isFallbackProfile) {
    findings.push(finding('PROFILE_FALLBACK_STATE', 'LOW', 10, 'Profile is using the shipped fallback state',
      'The client fallback profile is present; dependent level/unlock fields are not treated as player anomalies.',
      { restaurantName: profile.restaurantName, userLevel: profile.userLevel, gourmetPoint: profile.gourmetPoint }));
  }

  if (!Number.isInteger(profile.userLevel) || profile.userLevel < 0 || profile.userLevel >= LEVEL_POINTS.length) {
    findings.push(finding('LEVEL_OUT_OF_RANGE', 'CRITICAL', 100, 'Level is outside the shipped game',
      `Level ${profile.userLevel} is outside the original level range 0–${LEVEL_POINTS.length - 1}.`, { userLevel: profile.userLevel, maximumLevel: LEVEL_POINTS.length - 1 }));
  }
  if (!fallbackState && profile.userLevel > expectedLevel) {
    findings.push(finding('LEVEL_GOURMET_MISMATCH', 'CRITICAL', 100,
      'Level exceeds the gourmet total',
      `Level ${profile.userLevel} requires more gourmet than the stored ${profile.gourmetPoint.toLocaleString('en-US')}.`,
      { direction: 'LEVEL_AHEAD', userLevel: profile.userLevel, expectedLevel, storedGourmetPoint: profile.gourmetPoint, displayedGourmetPoint: Math.floor(profile.gourmetPoint / 10), minimumStoredForReportedLevel: LEVEL_POINTS[profile.userLevel] === undefined ? null : LEVEL_POINTS[profile.userLevel]! * 10 }));
  }
  if (profile.credits < 0 || profile.cashBalance < 0 || profile.gourmetPoint < 0) {
    findings.push(finding('NEGATIVE_PROFILE_BALANCE', 'CRITICAL', 100, 'Profile contains a negative balance',
      'Coins, Playfish Cash, and gourmet points must not be negative.', { credits: profile.credits, cashBalance: profile.cashBalance, gourmetPoint: profile.gourmetPoint }));
  }
  if (!fallbackState && profile.employees.length > unlocks.employees) {
    findings.push(finding('EMPLOYEE_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Employee limit exceeds level unlock',
      `${profile.employees.length} employees are stored; level ${profile.userLevel} permits ${unlocks.employees}.`, { employeeCount: profile.employees.length, permitted: unlocks.employees, userLevel: profile.userLevel }));
  }
  const occupiedPlots = profile.gardenPlots.filter((plot) => plot.ingredientId > 0).length;
  if (!fallbackState && occupiedPlots > unlocks.gardenPlots) {
    findings.push(finding('GARDEN_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Garden plots exceed level unlock',
      `${occupiedPlots} occupied plots are stored; level ${profile.userLevel} permits ${unlocks.gardenPlots}.`, { occupiedPlots, permitted: unlocks.gardenPlots, userLevel: profile.userLevel }));
  }
  // The profile stores activeFloorIndex as layout*2 (0/2/4) per
  // WorldRestaurantEditor.setLayout, so compare the decoded layout index and
  // reject odd (unrenderable) values.
  const layoutIndex = profile.activeFloorIndex / 2;
  if (!fallbackState && (profile.activeFloorIndex < 0 || profile.activeFloorIndex % 2 !== 0 || layoutIndex >= unlocks.layouts)) {
    findings.push(finding('LAYOUT_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Active layout exceeds level unlock',
      `Layout index ${layoutIndex} is active; level ${profile.userLevel} permits indexes 0–${unlocks.layouts - 1}.`, { activeFloorIndex: profile.activeFloorIndex, layoutIndex, layouts: unlocks.layouts, userLevel: profile.userLevel }));
  }

  const negativeInventory = profile.inventoryItems.filter((item) => item.number < 0).map((item) => ({ id: item.globalItemId, number: item.number }));
  const negativeIngredients = profile.ingredients.filter((item) => item.number < 0).map((item) => ({ id: item.globalItemId, number: item.number }));
  if (negativeInventory.length || negativeIngredients.length) {
    findings.push(finding('NEGATIVE_ITEM_QUANTITY', 'CRITICAL', 100, 'Inventory contains negative quantities',
      'One or more inventory rows contain impossible negative quantities.', { inventory: negativeInventory.slice(0, 20), ingredients: negativeIngredients.slice(0, 20) }));
  }

  const knownIds = new Set(fullCatalog().map((item) => item.id));
  const unknownIds = [...new Set([
    ...profile.ownedItems.map((item) => item.globalItemId),
    ...profile.inventoryItems.map((item) => item.globalItemId),
    ...profile.ingredients.map((item) => item.globalItemId),
    ...profile.gardenPlots.map((item) => item.ingredientId).filter((id) => id > 0),
  ].filter((id) => !knownIds.has(id)))];
  if (unknownIds.length > 0) {
    findings.push(finding('UNKNOWN_ITEM_IDENTITIES', 'LOW', 10, 'Profile contains data that needs repair',
      `${unknownIds.length} item ID${unknownIds.length === 1 ? '' : 's'} do not exist in shipped game data. This is a data-integrity alert, not evidence of player misconduct.`, { unknownIds: unknownIds.slice(0, 50), total: unknownIds.length }));
  }

  if (latestFact) evaluateSaveFact(latestFact, findings);
  return findings;
}

function evaluateSaveFact(fact: SaveFactLike, findings: RuleFinding[]): void {
  if (fact.clientDeltaSeconds < -15) findings.push(finding('CLIENT_TIME_REVERSED', 'CRITICAL', 90, 'Client save clock moved backwards', `Client time moved backwards by ${Math.abs(fact.clientDeltaSeconds)} seconds.`, { ...fact }));
  else if (fact.serverDeltaSeconds > 0 && fact.clientDeltaSeconds > fact.serverDeltaSeconds + 600) findings.push(finding('CLIENT_TIME_ACCELERATED', 'HIGH', 70, 'Client save clock advanced too quickly', `${fact.clientDeltaSeconds} client seconds elapsed during ${fact.serverDeltaSeconds} server seconds.`, { ...fact }));
  if (fact.unknownActionCount > 0) findings.push(finding('UNKNOWN_SAVE_ACTIONS', 'CRITICAL', 90, 'Save contains unknown audit actions', `${fact.unknownActionCount} audit actions are not defined by the shipped client.`, { unknownActionCount: fact.unknownActionCount, actionCount: fact.actionCount }));
}

function finding(ruleId: string, severity: FindingSeverity, score: number, title: string, summary: string, evidence: Readonly<Record<string, unknown>>): RuleFinding {
  return { ruleId, severity, score, title, summary, evidence };
}
