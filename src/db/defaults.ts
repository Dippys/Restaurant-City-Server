export const FACEBOOK_NETWORK = 2;
export const PLAYER_NETWORK_UID = '0';

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

export interface FriendProfileSeed {
  readonly networkUid: string;
  readonly playfishUid: number;
  readonly firstName: string;
  readonly fullName: string;
  readonly restaurantName: string;
  readonly gender: number;
  readonly credits: number;
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
  { id: 2000014, x: -60, y: -23 },
  { id: 2050008, x: 0, y: 0 },
  { id: 2040017, x: 30, y: 0 },
];

export const STARTER_RESTAURANT_ITEMS: readonly OwnedItemSeed[] = [
  { id: 3070000, x: 6, y: 2, data: 3 },
  { id: 3010000, x: 0, y: 4 },
  { id: 3000011, x: 0, y: 2 },
  { id: 3040001, x: 2, y: 3 },
  { id: 3030010, x: 3, y: 3 },
  { id: 3100000, x: 4, y: 0, data: 1 },
];

export const STARTER_FRIENDS: readonly FriendProfileSeed[] = [
  {
    networkUid: '1001',
    playfishUid: 1001,
    firstName: 'Mia',
    fullName: 'Mia Stone',
    restaurantName: 'Mia Cafe',
    gender: 1,
    credits: 1200,
    userLevel: 2,
    gourmetPoint: 350,
    trashPoint: 0,
    demandPoint: 3,
    musicPlay: 0,
    ownedItems: [
      ...STARTER_BUILDING_ITEMS,
      ...STARTER_RESTAURANT_ITEMS,
      { id: 3040001, x: 2, y: 5 },
      { id: 3030010, x: 3, y: 5 },
    ],
  },
  {
    networkUid: '1002',
    playfishUid: 1002,
    firstName: 'Jordan',
    fullName: 'Jordan Reed',
    restaurantName: 'Jordan Grill',
    gender: 0,
    credits: 6500,
    userLevel: 7,
    gourmetPoint: 5200,
    trashPoint: 1,
    demandPoint: 8,
    musicPlay: 0,
    ownedItems: [
      ...STARTER_BUILDING_ITEMS,
      ...STARTER_RESTAURANT_ITEMS,
      { id: 3000011, x: 0, y: 6 },
      { id: 3040001, x: 2, y: 5 },
      { id: 3040001, x: 5, y: 5 },
      { id: 3030010, x: 3, y: 5 },
      { id: 3030010, x: 6, y: 5 },
      { id: 3070000, x: 7, y: 2, data: 3 },
    ],
  },
  {
    networkUid: '1003',
    playfishUid: 1003,
    firstName: 'Sofia',
    fullName: 'Sofia Lane',
    restaurantName: 'Sofia Sushi',
    gender: 1,
    credits: 18000,
    userLevel: 14,
    gourmetPoint: 22000,
    trashPoint: 0,
    demandPoint: 14,
    musicPlay: 1,
    ownedItems: [
      ...STARTER_BUILDING_ITEMS,
      ...STARTER_RESTAURANT_ITEMS,
      { id: 2070000, x: 0, y: -100 },
      { id: 2000014, x: 60, y: -23 },
      { id: 2040002, x: 70, y: 0 },
      { id: 2040002, x: -70, y: 0 },
      { id: 3000011, x: 0, y: 6 },
      { id: 3040001, x: 2, y: 5 },
      { id: 3040001, x: 5, y: 5 },
      { id: 3030010, x: 3, y: 5 },
      { id: 3030010, x: 6, y: 5 },
      { id: 3040001, x: 5, y: 3 },
      { id: 3030010, x: 6, y: 3 },
      { id: 3070000, x: 7, y: 2, data: 3 },
      { id: 3060016, x: 0, y: 1 },
      { id: 3060016, x: 1, y: 0 },
    ],
  },
  {
    networkUid: '1004',
    playfishUid: 1004,
    firstName: 'Omar',
    fullName: 'Omar Hart',
    restaurantName: 'Omar Palace',
    gender: 0,
    credits: 75000,
    userLevel: 24,
    gourmetPoint: 95000,
    trashPoint: 0,
    demandPoint: 24,
    musicPlay: 1,
    ownedItems: [
      ...STARTER_BUILDING_ITEMS,
      ...STARTER_RESTAURANT_ITEMS,
      { id: 2070000, x: 0, y: -100 },
      { id: 2000014, x: 60, y: -23 },
      { id: 2040002, x: 70, y: 0 },
      { id: 2040002, x: -70, y: 0 },
      { id: 2040011, x: 120, y: 0 },
      { id: 3000011, x: 0, y: 6 },
      { id: 3040001, x: 2, y: 5 },
      { id: 3040001, x: 5, y: 5 },
      { id: 3040001, x: 5, y: 3 },
      { id: 3040001, x: 7, y: 5 },
      { id: 3030010, x: 3, y: 5 },
      { id: 3030010, x: 6, y: 5 },
      { id: 3030010, x: 6, y: 3 },
      { id: 3030010, x: 8, y: 5 },
      { id: 3070000, x: 7, y: 2, data: 3 },
      { id: 3070000, x: 8, y: 2, data: 3 },
      { id: 3060016, x: 0, y: 1 },
      { id: 3060016, x: 1, y: 0 },
      { id: 3200000, x: 2, y: 0, data: 1 },
      { id: 3300000, x: 1, y: 7 },
    ],
  },
];

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

export function defaultProfileName(networkUid: string): { firstName: string; fullName: string } {
  if (networkUid === PLAYER_NETWORK_UID) {
    return { firstName: 'Player', fullName: 'Player One' };
  }

  const firstName = `User${networkUid}`;
  return { firstName, fullName: `${firstName} Guest` };
}
