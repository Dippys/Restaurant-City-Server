// Spec: decompiled/game/scripts/com/playfish/games/cooking/GameWorld.as
// ADR-0034: explainable rules only; no rule performs punishment.
import { fullCatalog, itemAttributes } from '../db/item-catalog';

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
  const accountAgeHours = Math.max(0, (now.getTime() - profile.createdAt.getTime()) / 3_600_000);
  const activeHours = (activity?.totalActiveSeconds ?? 0) / 3600;

  if (!Number.isInteger(profile.userLevel) || profile.userLevel < 0 || profile.userLevel >= LEVEL_POINTS.length) {
    findings.push(finding('LEVEL_OUT_OF_RANGE', 'CRITICAL', 100, 'Level is outside the shipped game',
      `Level ${profile.userLevel} is outside the original level range 0–${LEVEL_POINTS.length - 1}.`, { userLevel: profile.userLevel, maximumLevel: LEVEL_POINTS.length - 1 }));
  }
  if (profile.userLevel !== expectedLevel) {
    const levelAhead = profile.userLevel > expectedLevel;
    findings.push(finding('LEVEL_GOURMET_MISMATCH', levelAhead ? 'CRITICAL' : 'HIGH', levelAhead ? 100 : 70,
      levelAhead ? 'Level exceeds the gourmet total' : 'Level is behind the gourmet total',
      levelAhead
        ? `Level ${profile.userLevel} requires more gourmet than the stored ${profile.gourmetPoint.toLocaleString('en-US')}.`
        : `${profile.gourmetPoint.toLocaleString('en-US')} stored gourmet maps to level ${expectedLevel}, while the profile is level ${profile.userLevel}. The shipped client catches up one level at a time, so review save history before treating this as manipulation.`,
      { direction: levelAhead ? 'LEVEL_AHEAD' : 'LEVEL_BEHIND', userLevel: profile.userLevel, expectedLevel, storedGourmetPoint: profile.gourmetPoint, displayedGourmetPoint: Math.floor(profile.gourmetPoint / 10), minimumStoredForReportedLevel: LEVEL_POINTS[profile.userLevel] === undefined ? null : LEVEL_POINTS[profile.userLevel]! * 10 }));
  }
  if (profile.credits < 0 || profile.cashBalance < 0 || profile.gourmetPoint < 0) {
    findings.push(finding('NEGATIVE_PROFILE_BALANCE', 'CRITICAL', 100, 'Profile contains a negative balance',
      'Coins, Playfish Cash, and gourmet points must not be negative.', { credits: profile.credits, cashBalance: profile.cashBalance, gourmetPoint: profile.gourmetPoint }));
  }
  if (profile.employees.length > unlocks.employees) {
    findings.push(finding('EMPLOYEE_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Employee limit exceeds level unlock',
      `${profile.employees.length} employees are stored; level ${profile.userLevel} permits ${unlocks.employees}.`, { employeeCount: profile.employees.length, permitted: unlocks.employees, userLevel: profile.userLevel }));
  }
  const occupiedPlots = profile.gardenPlots.filter((plot) => plot.ingredientId > 0).length;
  if (occupiedPlots > unlocks.gardenPlots) {
    findings.push(finding('GARDEN_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Garden plots exceed level unlock',
      `${occupiedPlots} occupied plots are stored; level ${profile.userLevel} permits ${unlocks.gardenPlots}.`, { occupiedPlots, permitted: unlocks.gardenPlots, userLevel: profile.userLevel }));
  }
  // The profile stores activeFloorIndex as layout*2 (0/2/4) per
  // WorldRestaurantEditor.setLayout, so compare the decoded layout index and
  // reject odd (unrenderable) values.
  const layoutIndex = profile.activeFloorIndex / 2;
  if (profile.activeFloorIndex < 0 || profile.activeFloorIndex % 2 !== 0 || layoutIndex >= unlocks.layouts) {
    findings.push(finding('LAYOUT_UNLOCK_EXCEEDED', 'CRITICAL', 95, 'Active layout exceeds level unlock',
      `Layout index ${layoutIndex} is active; level ${profile.userLevel} permits indexes 0–${unlocks.layouts - 1}.`, { activeFloorIndex: profile.activeFloorIndex, layoutIndex, layouts: unlocks.layouts, userLevel: profile.userLevel }));
  }

  const selectedByCourse = new Map<number, number>();
  for (const item of profile.inventoryItems) {
    if (!item.isSelected || item.globalItemId < 5_000_000 || item.globalItemId >= 5_400_000) continue;
    const course = Math.floor(item.globalItemId / 100_000);
    selectedByCourse.set(course, (selectedByCourse.get(course) ?? 0) + 1);
  }
  const overSelected = [...selectedByCourse.entries()].filter(([, count]) => count > unlocks.numDishes);
  if (overSelected.length > 0) {
    findings.push(finding('MENU_UNLOCK_EXCEEDED', 'HIGH', 65, 'Selected dishes exceed level unlock',
      `At least one course has more selected dishes than level ${profile.userLevel} permits. Legacy migrated rows can also cause this.`, { selectedByCourse: Object.fromEntries(overSelected), permittedPerCourse: unlocks.numDishes, userLevel: profile.userLevel }));
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
    findings.push(finding('UNKNOWN_ITEM_IDENTITIES', 'MEDIUM', 35, 'Profile contains unknown item identities',
      `${unknownIds.length} item ID${unknownIds.length === 1 ? '' : 's'} do not exist in shipped game data. Legacy parser damage can also cause this.`, { unknownIds: unknownIds.slice(0, 50), total: unknownIds.length }));
  }

  if (latestFact) evaluateSaveFact(latestFact, findings);
  if (accountAgeHours <= 24 && expectedLevel >= 20) {
    findings.push(finding('RAPID_NEW_ACCOUNT_PROGRESSION', 'HIGH', 75, 'New account reached advanced progression',
      `The profile reached level ${expectedLevel} within ${accountAgeHours.toFixed(1)} hours of creation.`, { accountAgeHours, expectedLevel, gourmetPoint: profile.gourmetPoint }));
  }
  // Lifetime totals vs measured activity only make sense once the activity
  // tracker has at least one measured hour; a fresh tracker (it starts when
  // ADR-0034 lands) would otherwise flag every established player.
  if (activity && activeHours >= 1 && activeHours < 2 && profile.gourmetPoint >= 100_000) {
    findings.push(finding('GOURMET_VS_MEASURED_TIME', 'HIGH', 70, 'Gourmet total is extreme for measured activity',
      `${profile.gourmetPoint.toLocaleString('en-US')} gourmet is stored after ${activeHours.toFixed(2)} measured active hours.`, { gourmetPoint: profile.gourmetPoint, measuredActiveSeconds: activity.totalActiveSeconds }));
  }
  if (activity && activeHours >= 1 && activeHours < 2 && profile.credits >= 1_000_000) {
    findings.push(finding('COINS_VS_MEASURED_TIME', 'HIGH', 70, 'Coin balance is extreme for measured activity',
      `${profile.credits.toLocaleString('en-US')} coins are stored after ${activeHours.toFixed(2)} measured active hours.`, { credits: profile.credits, measuredActiveSeconds: activity.totalActiveSeconds }));
  }

  const placedValue = profile.ownedItems.reduce((sum, item) => sum + coinCost(item.globalItemId), 0);
  const inventoryValue = profile.inventoryItems.reduce((sum, item) => sum + coinCost(item.globalItemId) * Math.max(0, item.number), 0);
  const apparentWealth = profile.credits + placedValue + inventoryValue;
  if (activity && activeHours >= 1 && activeHours < 5 && apparentWealth >= 5_000_000) {
    findings.push(finding('WEALTH_VS_MEASURED_TIME', 'HIGH', 65, 'Apparent wealth is extreme for measured activity',
      `Coins plus coin-priced assets total about ${apparentWealth.toLocaleString('en-US')} after ${activeHours.toFixed(1)} measured hours.`, { credits: profile.credits, placedValue, inventoryValue, apparentWealth, measuredActiveSeconds: activity.totalActiveSeconds }));
  }
  if (expectedLevel >= 20 && profile.ownedItems.length <= 35 && profile.inventoryItems.length <= 8) {
    findings.push(finding('HIGH_PROGRESS_STARTER_RESTAURANT', 'LOW', 20, 'Advanced profile retains a near-starter restaurant',
      `Level ${expectedLevel} has only ${profile.ownedItems.length} placed and ${profile.inventoryItems.length} inventory rows. This is contextual, not proof.`, { expectedLevel, placedItems: profile.ownedItems.length, inventoryRows: profile.inventoryItems.length }));
  }
  return findings;
}

function evaluateSaveFact(fact: SaveFactLike, findings: RuleFinding[]): void {
  const absGourmet = Math.abs(fact.gourmetDelta);
  const absCredits = Math.abs(fact.creditDelta);
  if (absGourmet >= 250_000) findings.push(finding('EXTREME_GOURMET_SAVE_DELTA', 'CRITICAL', 100, 'Extreme gourmet change in one save', `${signed(fact.gourmetDelta)} gourmet was committed in one accepted save.`, { ...fact }));
  else if (absGourmet >= 50_000 && fact.clientDeltaSeconds <= 900) findings.push(finding('RAPID_GOURMET_SAVE_DELTA', 'HIGH', 80, 'Rapid gourmet change', `${signed(fact.gourmetDelta)} gourmet was committed across ${fact.clientDeltaSeconds} client seconds.`, { ...fact }));
  if (absCredits >= 10_000_000) findings.push(finding('EXTREME_COIN_SAVE_DELTA', 'CRITICAL', 100, 'Extreme coin change in one save', `${signed(fact.creditDelta)} coins was committed in one accepted save.`, { ...fact }));
  else if (absCredits >= 1_000_000) findings.push(finding('LARGE_COIN_SAVE_DELTA', 'HIGH', 80, 'Large coin change in one save', `${signed(fact.creditDelta)} coins was committed in one accepted save.`, { ...fact }));
  if (fact.clientDeltaSeconds < 0) findings.push(finding('CLIENT_TIME_REVERSED', 'CRITICAL', 90, 'Client save clock moved backwards', `Client time moved backwards by ${Math.abs(fact.clientDeltaSeconds)} seconds.`, { ...fact }));
  else if (fact.serverDeltaSeconds > 0 && fact.clientDeltaSeconds > fact.serverDeltaSeconds + 600) findings.push(finding('CLIENT_TIME_ACCELERATED', 'HIGH', 70, 'Client save clock advanced too quickly', `${fact.clientDeltaSeconds} client seconds elapsed during ${fact.serverDeltaSeconds} server seconds.`, { ...fact }));
  if (fact.actionCount > 1000) findings.push(finding('EXCESSIVE_SAVE_ACTIONS', 'HIGH', 65, 'Save contains an excessive audit batch', `${fact.actionCount} audit actions were submitted in one save.`, { actionCount: fact.actionCount }));
  if (fact.unknownActionCount > 0) findings.push(finding('UNKNOWN_SAVE_ACTIONS', 'CRITICAL', 90, 'Save contains unknown audit actions', `${fact.unknownActionCount} audit actions are not defined by the shipped client.`, { unknownActionCount: fact.unknownActionCount, actionCount: fact.actionCount }));
}

function coinCost(itemId: number): number {
  const attributes = itemAttributes(itemId);
  if (!attributes || attributes.cash) return 0;
  const cost = Number(attributes.cost ?? 0);
  return Number.isFinite(cost) && cost > 0 ? Math.trunc(cost) : 0;
}

function finding(ruleId: string, severity: FindingSeverity, score: number, title: string, summary: string, evidence: Readonly<Record<string, unknown>>): RuleFinding {
  return { ruleId, severity, score, title, summary, evidence };
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toLocaleString('en-US')}`;
}
