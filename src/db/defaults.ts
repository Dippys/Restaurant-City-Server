export const FACEBOOK_NETWORK = 2;
export const PLAYER_NETWORK_UID = '0';

// Reserved network uid for server-originated ("Restaurant City") system mail such
// as the daily quiz and daily free-ingredient bonus. Never appears in friend lists.
export const SYSTEM_NETWORK_UID = '1';
export const SYSTEM_SENDER = {
  networkUid: SYSTEM_NETWORK_UID,
  playfishUid: 1,
  firstName: 'Restaurant City',
  fullName: 'Restaurant City',
  restaurantName: 'Restaurant City',
} as const;

export interface ItemCatalogEntry {
  readonly id: number;
  readonly label: string;
  readonly category: string;
}

export interface OwnedItemSeed {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly data?: number;
  readonly roomIndex?: number;
}

export interface RecipeSeed {
  readonly id: number;
  readonly name: string;
  readonly level: number;
  readonly selected: boolean;
}

export interface IngredientSeed {
  readonly id: number;
  readonly name: string;
  readonly count: number;
}

export interface FriendProfileSeed {
  readonly networkUid: string;
  readonly playfishUid: number;
  readonly firstName: string;
  readonly fullName: string;
  readonly restaurantName: string;
  readonly gender: number;
  readonly credits: number;
  readonly playCount: number;
  readonly userLevel: number;
  readonly gourmetPoint: number;
  readonly trashPoint: number;
  readonly demandPoint: number;
  readonly musicPlay: number;
  readonly ownedItems: readonly OwnedItemSeed[];
}

export const STARTER_BUILDING_ITEMS: readonly OwnedItemSeed[] = [
  { id: 2060000, x: 0, y: 0 },
  { id: 2020001, x: 0, y: 0 },
  { id: 2010012, x: 0, y: 0 },
  { id: 2070000, x: 0, y: -100 },
  { id: 2000014, x: 60, y: -23 },
  { id: 2000014, x: -60, y: -23 },
  { id: 2050008, x: 0, y: 0 },
  { id: 2040002, x: 70, y: 0 },
  { id: 2040002, x: -70, y: 0 },
  { id: 2040017, x: 30, y: 0 },
  { id: 2040011, x: 120, y: 0 },
];

export const STARTER_RESTAURANT_ITEMS: readonly OwnedItemSeed[] = [
  { id: 3070000, x: 6, y: 2, data: 3 },
  { id: 3010000, x: 0, y: 4 },
  { id: 3000011, x: 0, y: 2 },
  { id: 3000011, x: 0, y: 6 },
  { id: 3040001, x: 2, y: 3 },
  { id: 3040001, x: 2, y: 5 },
  { id: 3040001, x: 5, y: 5 },
  { id: 3030010, x: 3, y: 3 },
  { id: 3030010, x: 3, y: 5 },
  { id: 3030010, x: 6, y: 5 },
  { id: 3060016, x: 0, y: 1 },
  { id: 3060016, x: 1, y: 0 },
  { id: 3200000, x: 2, y: 0, data: 1 },
  { id: 3300000, x: 1, y: 7 },
  { id: 3100000, x: 4, y: 0, data: 1 },
  { id: 3020003, x: 1, y: 1 },
  { id: 3020003, x: 7, y: 1 },
  { id: 3020003, x: 7, y: 7 },
];

// Demand a fresh restaurant starts with. Mirrors GameWorld.DEFAULT_DEMAND (120),
// which the client forces on the new-player boot path (GameWorld.start else-branch).
export const DEFAULT_NEW_PLAYER_DEMAND = 120;

// The three default menu dishes the original PlayFish server granted a brand-new
// player: one Starter, one Main, one Dessert. The client's fresh-user boot path
// does NOT create these itself (WorldRestaurant only seeds furniture), so without
// them a new player has an empty menu and cannot cook. Delivered as recipe
// inventory items where `number` is the recipe level and `isSelected` puts it on
// the active menu (see GameUser.addItemsFromProfileObject).
export const STARTER_RECIPES: readonly RecipeSeed[] = [
  { id: 5000008, name: 'Garden Salad', level: 1, selected: true },
  { id: 5100003, name: 'Burger and Fries', level: 1, selected: true },
  { id: 5200000, name: 'Fruit Selection', level: 1, selected: true },
];

// The seven ingredients flagged initial="1"/"2" in ingredient[1].bin — the only
// data-driven "new player" marker in the client assets. Together they are exactly
// the ingredients the three STARTER_RECIPES need. The starting stock (`count`)
// mirrors that initial value (Egg/Salad/Tomato = 2, the rest = 1).
export const STARTER_INGREDIENTS: readonly IngredientSeed[] = [
  { id: 4000005, name: 'Beef', count: 1 },
  { id: 4000013, name: 'Egg', count: 2 },
  { id: 4000031, name: 'Potato', count: 1 },
  { id: 4000034, name: 'Salad', count: 2 },
  { id: 4000036, name: 'Strawberry', count: 1 },
  { id: 4000040, name: 'Tomato', count: 2 },
  { id: 4000047, name: 'Apple', count: 1 },
];

// Six fake friends. Every one is seeded in the same fresh, level-1 default state
// as a brand-new player (starter building + restaurant layout, and — via the
// food backfill in profile-store — the starter menu, ingredients, and demand 120),
// differing only by name and gender.
const DEFAULT_FRIENDS: ReadonlyArray<{ firstName: string; fullName: string; restaurantName: string; gender: number }> = [
  { firstName: 'Mia', fullName: 'Mia Stone', restaurantName: "Mia's Restaurant", gender: 2 },
  { firstName: 'Jordan', fullName: 'Jordan Reed', restaurantName: "Jordan's Restaurant", gender: 1 },
  { firstName: 'Sofia', fullName: 'Sofia Lane', restaurantName: "Sofia's Restaurant", gender: 2 },
  { firstName: 'Omar', fullName: 'Omar Hart', restaurantName: "Omar's Restaurant", gender: 1 },
  { firstName: 'Lily', fullName: 'Lily Park', restaurantName: "Lily's Restaurant", gender: 2 },
  { firstName: 'Noah', fullName: 'Noah Cole', restaurantName: "Noah's Restaurant", gender: 1 },
];

export const STARTER_FRIENDS: readonly FriendProfileSeed[] = DEFAULT_FRIENDS.map((friend, index) => ({
  networkUid: String(1001 + index),
  playfishUid: 1001 + index,
  firstName: friend.firstName,
  fullName: friend.fullName,
  restaurantName: friend.restaurantName,
  gender: friend.gender,
  credits: 0,
  playCount: 1,
  userLevel: 1,
  gourmetPoint: 0,
  trashPoint: 0,
  demandPoint: DEFAULT_NEW_PLAYER_DEMAND,
  musicPlay: 0,
  ownedItems: [...STARTER_BUILDING_ITEMS, ...STARTER_RESTAURANT_ITEMS],
}));

export const ITEM_CATALOG: readonly ItemCatalogEntry[] = [
  { id: 2000014, label: 'Basic window', category: 'Building' },
  { id: 2010012, label: 'Basic door', category: 'Building' },
  { id: 2020001, label: 'Red tile roof', category: 'Building' },
  { id: 2040002, label: 'Flower bed', category: 'Building' },
  { id: 2040011, label: 'Trashcan', category: 'Building' },
  { id: 2040017, label: 'Wooden menu board', category: 'Building' },
  { id: 2050008, label: 'Dark grey bricks', category: 'Building' },
  { id: 2060000, label: 'Starter building base', category: 'Building' },
  { id: 2070000, label: 'Wooden banner', category: 'Building' },
  { id: 3000011, label: 'Basic window', category: 'Restaurant' },
  { id: 3010000, label: 'Simple door', category: 'Restaurant' },
  { id: 3020003, label: 'Delicate bush', category: 'Restaurant' },
  { id: 3030010, label: 'White cloth table', category: 'Restaurant' },
  { id: 3040001, label: 'Classic chair', category: 'Restaurant' },
  { id: 3060016, label: 'Neutral blue wall tile', category: 'Restaurant' },
  { id: 3070000, label: 'Stove', category: 'Restaurant' },
  { id: 3100000, label: 'Menu holder', category: 'Restaurant' },
  { id: 3200000, label: 'Achievement panel', category: 'Restaurant' },
  { id: 3300000, label: 'Letter box', category: 'Restaurant' },
];

export function isKnownItemId(id: number): boolean {
  return ITEM_CATALOG.some((item) => item.id === id);
}

// The network uids of the seeded NPC friends. These profiles have no real client,
// so the server acts on their behalf (auto-accepting trades, reciprocating gifts).
export const NPC_NETWORK_UIDS: readonly string[] = STARTER_FRIENDS.map((friend) => friend.networkUid);

export function isNpcUid(networkUid: string): boolean {
  return NPC_NETWORK_UIDS.includes(networkUid);
}

// Reserved (non-player) uids that must never surface as friends/street users.
export function isReservedUid(networkUid: string): boolean {
  return networkUid === PLAYER_NETWORK_UID || networkUid === SYSTEM_NETWORK_UID;
}

// Ingredient pool used for the daily free-ingredient bonus and NPC gifts. Mirrors
// the starter ingredient set (all guaranteed to exist in ingredient[1].bin).
export const DAILY_INGREDIENT_POOL: readonly number[] = STARTER_INGREDIENTS.map((ingredient) => ingredient.id);

export function defaultProfileName(networkUid: string): { firstName: string; fullName: string } {
  if (networkUid === PLAYER_NETWORK_UID) {
    return { firstName: 'Player', fullName: 'Player One' };
  }

  const firstName = `User${networkUid}`;
  return { firstName, fullName: `${firstName} Guest` };
}
