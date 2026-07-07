import type { ParsedRequest, ParsedSubRequest } from './codec';
import {
  readString,
  readVarint,
  writeArray,
  writeBool,
  writeDate,
  writeIntvar32,
  writeNetworkUid,
  writeString,
  writeU8,
  writeVarint,
} from './codec';

type RpcResponder = (request: ParsedRequest | ParsedSubRequest) => Buffer | null;

const FAKE_BALANCE = 999999;
const STATUS_OK = 0;
const SAVE_STATUS_OK = 0;
const FACEBOOK_NETWORK = 2;

let fallbackSaveVersion = 1;

interface OwnedItemSeed {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly data?: number;
}

const DEFAULT_BUILDING_ITEMS: readonly OwnedItemSeed[] = [
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

const DEFAULT_RESTAURANT_ITEMS: readonly OwnedItemSeed[] = [
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

function writeIngredientMarketItem(ingredientId: number, price: number): Buffer {
  return Buffer.concat([writeVarint(ingredientId), writeVarint(price)]);
}

function writeOwnedItem(item: OwnedItemSeed, serverUid: number): Buffer {
  return Buffer.concat([
    writeIntvar32(serverUid),
    writeVarint(item.id),
    writeIntvar32(item.x),
    writeIntvar32(item.y),
    writeU8(item.data ?? 0),
    writeNetworkUid(0, ''),
    writeU8(0),
  ]);
}

function writeProfile(id: number, includeFullState: boolean): Buffer {
  const firstName = `Dummy${id}`;
  const fullName = `${firstName} Tummy`;
  const gourmetPoints = id === 0 ? 10000 : 1000 + id * 100;
  const ownedItems = [...DEFAULT_BUILDING_ITEMS, ...DEFAULT_RESTAURANT_ITEMS].map((item, index) => (
    writeOwnedItem(item, -index - 1)
  ));

  const parts = [
    writeNetworkUid(FACEBOOK_NETWORK, String(id), id),
    writeU8(includeFullState ? 5 : 2),
    writeBool(false),
    writeString(firstName),
    writeString(fullName),
    writeString(''),
    writeString(''),
    writeU8(id % 2),
    writeString(firstName),
    writeVarint(50000),
    writeIntvar32(2),
    writeVarint(gourmetPoints),
    writeVarint(0),
    writeVarint(0),
    writeVarint(1),
    writeVarint(120),
    writeVarint(0),
    writeBool(false),
    writeVarint(Math.floor(Date.now() / 1000)),
    writeDate(0),
    writeBool(false),
    writeU8(1),
    writeU8(0),
  ];

  if (!includeFullState) {
    return Buffer.concat(parts);
  }

  return Buffer.concat([
    ...parts,
    writeArray(ownedItems),
    writeBool(true),
    writeArray([]),
    writeArray([]),
    writeU8(0),
    writeArray([]),
    writeArray([]),
    writeBool(true),
    writeArray([]),
    writeArray([]),
    writeArray([]),
    writeArray([]),
  ]);
}

function getUserProfile(): Buffer {
  return Buffer.concat([
    writeProfile(0, true),
    writeArray([
      writeIngredientMarketItem(4000000, 1000),
      writeIngredientMarketItem(4000001, 1000),
      writeIngredientMarketItem(4000002, 1000),
    ]),
  ]);
}

function getAllFriends(): Buffer {
  const friends = Array.from({ length: 20 }, (_, index) => writeProfile(index, false));
  return writeArray(friends);
}

function getUsers(request: ParsedRequest | ParsedSubRequest): Buffer {
  const requestedIds = readRequestedUserIds(requestBody(request));
  const users = requestedIds.map((id) => writeProfile(id, false));
  return writeArray(users);
}

function readBookmarkCount(): Buffer {
  return Buffer.concat([
    writeU8(STATUS_OK),
    writeIntvar32(0),
  ]);
}

function saveProfile(request: ParsedRequest | ParsedSubRequest): Buffer {
  const requestedVersion = extractSaveVersion(requestBody(request));
  const savedVersion = requestedVersion ?? fallbackSaveVersion;
  fallbackSaveVersion = savedVersion + 1;

  return Buffer.concat([
    writeU8(SAVE_STATUS_OK),
    writeVarint(savedVersion),
    writeArray([]),
    writeBool(false),
    writeVarint(0),
    writeArray([]),
  ]);
}

function purchaseCashItem(): Buffer {
  return Buffer.concat([
    writeU8(STATUS_OK),
    writeVarint(FAKE_BALANCE),
  ]);
}

function writeBookmarkCount(): Buffer {
  return writeU8(STATUS_OK);
}

function extractSaveVersion(body: Buffer): number | null {
  try {
    let pos = skipNetworkUid(body, 0);
    [, pos] = readString(body, pos);

    for (let i = 0; i < 4; i += 1) {
      [, pos] = readVarint(body, pos);
    }

    pos += 1;
    const hasAwards = body[pos] === 1;
    pos += 1;

    if (hasAwards) {
      let awardsLength = 0;
      [awardsLength, pos] = readVarint(body, pos);
      pos += awardsLength;
    }

    pos += 2;

    let saveVersion = 0;
    [saveVersion] = readVarint(body, pos);
    return saveVersion;
  } catch {
    return null;
  }
}

function skipNetworkUid(body: Buffer, pos: number): number {
  let network = 0;
  [network, pos] = readVarint(body, pos);

  if (network === 0) {
    return pos;
  }

  [, pos] = readString(body, pos);
  [, pos] = readVarint(body, pos);
  return pos;
}

function requestBody(request: ParsedRequest | ParsedSubRequest): Buffer {
  return 'body' in request ? request.body : (request.args ?? Buffer.alloc(0));
}

function readRequestedUserIds(body: Buffer): number[] {
  try {
    let pos = 1;
    let count = 0;
    [count, pos] = readVarint(body, pos);

    const ids: number[] = [];
    for (let i = 0; i < count; i += 1) {
      let network = 0;
      [network, pos] = readVarint(body, pos);

      if (network === 0) {
        continue;
      }

      let networkUid = '';
      [networkUid, pos] = readString(body, pos);

      let playfishUid = 0;
      [playfishUid, pos] = readVarint(body, pos);

      const numericUid = Number.parseInt(networkUid, 10);
      ids.push(Number.isFinite(numericUid) ? numericUid : playfishUid);
    }

    return ids;
  } catch {
    return [];
  }
}

export const responders: Readonly<Record<number, RpcResponder>> = {
  1: () => writeString(''),
  2: getAllFriends,
  3: getUserProfile,
  4: getUsers,
  5: saveProfile,
  20: () => writeArray([]),
  40: purchaseCashItem,
  41: purchaseCashItem,
  42: purchaseCashItem,
  44: readBookmarkCount,
  45: writeBookmarkCount,
  46: () => writeU8(STATUS_OK),
  246: () => Buffer.concat([writeBool(false), writeArray([])]),
  248: () => writeVarint(FAKE_BALANCE),
  249: () => writeDate(Math.floor(Date.now() / 1000)),
  250: () => writeArray([]),
  251: () => Buffer.alloc(0),
  254: () => Buffer.alloc(0),
};
