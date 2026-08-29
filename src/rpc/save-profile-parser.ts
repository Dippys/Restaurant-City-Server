import type {
  EmployeeData,
  FloorData,
  GardenChangeData,
  IngredientChangeData,
  IngredientLockData,
  BulkInventoryMoveData,
  InventoryItemData,
  NetworkUidData,
  OwnedItemData,
  PurchaseAuditData,
  SaveAuditData,
  SavedProfileData,
} from '../db/profile-store';
import { resolveRecipeEntry } from '../db/recipe-catalog';
import { itemIdForToken } from '../db/item-catalog';
import {
  readArray,
  readBool,
  readByteArray,
  readIntvar32,
  readNetworkUid,
  readString,
  readU8,
  readVarint,
} from './codec';

const ACTION_SELL_OWNED_ITEM = 4;
const ACTION_PURCHASE_INVENTORY_ITEM = 3;
const ACTION_FROM_GAME_TO_INVENTORY = 5;
const ACTION_FROM_INVENTORY_TO_GAME = 6;
const ACTION_UPDATE_EMPLOYEE = 8;
const ACTION_LOCK_INGREDIENT = 9;
const ACTION_HIRE_EMPLOYEE = 17;
const ACTION_FIRE_EMPLOYEE = 18;
const ACTION_SELL_INVENTORY_ITEM = 19;
const ACTION_OPEN_MAIL = 20;
const ACTION_DELETE_MAIL = 21;
const ACTION_PURCHASE_OWNED_ITEM = 22;
const ACTION_SAVE_OWNED_ITEM = 23;
const ACTION_LVL_UPDATE = 25;
const ACTION_PURCHASE_PERKS = 32;
const ACTION_ADD_RECIPE = 33;
const ACTION_PURCHASE_INGREDIENT = 34;
const ACTION_SELECT_RECIPE = 37;
const ACTION_SEED_PLANT = 38;
const ACTION_WATER_PLANT = 39;
const ACTION_HARVEST_PLANT = 40;
const ACTION_CONSUME_ITEM = 41;
const ACTION_CREDIT_VISIT_FRIEND = 49;
const ACTION_SAVE_FLOOR = 7;
const ACTION_SAVE_FLOORS = 50;
const ACTION_MOVE_IN_GAME_ITEMS_TO_INVENTORY = 51;
const KNOWN_ACTIONS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 48, 49, 50, 51]);

export interface ParsedSaveProfile {
  readonly profile: SavedProfileData;
  readonly audit: SaveAuditData;
}

export function parseSaveProfile(body: Buffer): ParsedSaveProfile {
  let pos = 0;

  const [id, afterId] = readNetworkUid(body, pos);
  pos = afterId;

  let restaurantName = '';
  [restaurantName, pos] = readString(body, pos);

  let gourmetPoint = 0;
  [gourmetPoint, pos] = readVarint(body, pos);

  let trashPoint = 0;
  [trashPoint, pos] = readVarint(body, pos);

  let demandPoint = 0;
  [demandPoint, pos] = readVarint(body, pos);

  let musicPlay = 0;
  [musicPlay, pos] = readVarint(body, pos);

  let isInStreet = false;
  [isInStreet, pos] = readBool(body, pos);

  let hasAwards = false;
  [hasAwards, pos] = readBool(body, pos);

  let awards: Buffer | null = null;
  if (hasAwards) {
    [awards, pos] = readByteArray(body, pos);
  }

  let userLevel = 0;
  [userLevel, pos] = readU8(body, pos);

  let activeFloorIndex = 0;
  [activeFloorIndex, pos] = readU8(body, pos);

  let saveVersion = 0;
  [saveVersion, pos] = readVarint(body, pos);

  let timeOnClient = 0;
  [timeOnClient, pos] = readVarint(body, pos);

  const audit = readAuditChanges(body, pos);

  return {
    profile: {
      id: normalizeNetworkUid(id),
      restaurantName,
      gourmetPoint,
      trashPoint,
      demandPoint,
      musicPlay,
      isInStreet,
      awards,
      userLevel,
      activeFloorIndex,
    },
    audit: {
      saveVersion,
      timeOnClient,
      ...audit,
    },
  };
}

function readAuditChanges(
  body: Buffer,
  pos: number,
): Omit<SaveAuditData, 'saveVersion' | 'timeOnClient'> {
  const upsertOwnedItems: OwnedItemData[] = [];
  const removeOwnedItemIds: number[] = [];
  const inventoryChanges: InventoryItemData[] = [];
  const bulkInventoryMoves: BulkInventoryMoveData[] = [];
  const ingredientChanges: IngredientChangeData[] = [];
  const lockIngredientChanges: IngredientLockData[] = [];
  const gardenChanges: GardenChangeData[] = [];
  const floorChanges: FloorData[] = [];
  const employeeChanges: EmployeeData[] = [];
  const openMailIds: number[] = [];
  const deleteMailIds: number[] = [];
  const visitedFriends: NetworkUidData[] = [];
  const purchases: PurchaseAuditData[] = [];
  let creditDelta = 0;
  let newCredits: number | null = null;
  let unknownActionCount = 0;
  const actionTypeCounts: Record<string, number> = {};

  let count = 0;
  [count, pos] = readVarint(body, pos);

  for (let i = 0; i < count; i += 1) {
    let action = 0;
    [action, pos] = readU8(body, pos);
    actionTypeCounts[String(action)] = (actionTypeCounts[String(action)] ?? 0) + 1;
    if (!KNOWN_ACTIONS.has(action)) unknownActionCount += 1;

    let actionNewCredits = 0;
    [actionNewCredits, pos] = readVarint(body, pos);
    if (actionNewCredits > 0) {
      newCredits = actionNewCredits;
    }

    let actionCreditDelta = 0;
    [actionCreditDelta, pos] = readIntvar32(body, pos);
    creditDelta += actionCreditDelta;

    switch (action) {
      case ACTION_FROM_GAME_TO_INVENTORY:
        {
          const [item, nextPos] = readOwnedItem(body, pos);
          pos = nextPos;
          removeOwnedItemIds.push(item.serverId);
          inventoryChanges.push({ globalItemId: item.globalItemId, delta: 1 });
        }
        break;
      case ACTION_FROM_INVENTORY_TO_GAME:
        {
          const [item, nextPos] = readOwnedItem(body, pos);
          pos = nextPos;
          upsertOwnedItems.push(item);
          inventoryChanges.push({ globalItemId: item.globalItemId, delta: -1 });
        }
        break;
      case ACTION_SAVE_OWNED_ITEM:
        {
          const [item, nextPos] = readOwnedItem(body, pos);
          pos = nextPos;
          upsertOwnedItems.push(item);
        }
        break;
      case ACTION_PURCHASE_OWNED_ITEM:
        {
          const [token, nextPos] = readString(body, pos);
          pos = nextPos;
          const [item, itemNextPos] = readOwnedItem(body, pos);
          pos = itemNextPos;
          upsertOwnedItems.push(item);
          purchases.push({ kind: 'owned', itemId: item.globalItemId, qty: 1, token });
        }
        break;
      case ACTION_SELL_OWNED_ITEM:
        {
          const [item, nextPos] = readOwnedItem(body, pos);
          pos = nextPos;
          [, pos] = readString(body, pos);
          removeOwnedItemIds.push(item.serverId);
        }
        break;
      case ACTION_SELL_INVENTORY_ITEM:
        {
          [, pos] = readString(body, pos);
          const [item, nextPos] = readInventoryItem(body, pos);
          pos = nextPos;
          inventoryChanges.push({ globalItemId: item.globalItemId, delta: -Math.max(1, item.number), selected: item.isSelected });
        }
        break;
      case ACTION_PURCHASE_INVENTORY_ITEM:
      case ACTION_PURCHASE_PERKS:
      case ACTION_ADD_RECIPE:
        {
          const [token, nextPos] = readString(body, pos);
          pos = nextPos;
          if (action === ACTION_PURCHASE_PERKS || action === ACTION_PURCHASE_INVENTORY_ITEM) {
            let qty = 0;
            [qty, pos] = readVarint(body, pos);
            const itemId = itemIdForToken(token);
            inventoryChanges.push({ globalItemId: itemId ?? 0, delta: Math.max(1, qty) });
            purchases.push({
              kind: action === ACTION_PURCHASE_PERKS ? 'perk' : 'inventory',
              itemId,
              qty: Math.max(1, qty),
              token,
              unresolved: itemId === undefined,
            });
          } else {
            const recipe = resolveRecipeEntry(token);
            const recipeId = recipe?.id ?? itemIdFromToken(token);
            // SaveProfileHandler.addRecipe() means "learn/level this recipe".
            // It carries no menu-selection flag; forcing selected=true here
            // made ordinary upgrades exceed the shipped per-course menu cap.
            inventoryChanges.push({ globalItemId: recipeId, delta: 1 });
            for (const ingredientId of recipe?.ingredientIds ?? []) {
              ingredientChanges.push({ globalItemId: ingredientId, delta: -1 });
            }
          }
        }
        break;
      case ACTION_OPEN_MAIL:
        {
          let ids: number[] = [];
          [ids, pos] = readArray(body, pos, (itemPos) => readVarint(body, itemPos));
          openMailIds.push(...ids);
        }
        break;
      case ACTION_DELETE_MAIL:
        {
          let ids: number[] = [];
          [ids, pos] = readArray(body, pos, (itemPos) => readVarint(body, itemPos));
          deleteMailIds.push(...ids);
        }
        break;
      case ACTION_LVL_UPDATE:
        pos = skipVarint(body, pos);
        break;
      case ACTION_PURCHASE_INGREDIENT:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          let qty = 0;
          [qty, pos] = readVarint(body, pos);
          ingredientChanges.push({ globalItemId: itemId, delta: Math.max(1, qty) });
          purchases.push({ kind: 'ingredient', itemId, qty: Math.max(1, qty) });
        }
        break;
      case ACTION_SELECT_RECIPE:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          let flag = false;
          [flag, pos] = readBool(body, pos);
          inventoryChanges.push({ globalItemId: itemId, delta: 0, selected: flag });
        }
        break;
      case ACTION_SEED_PLANT:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          gardenChanges.push({ plotId: itemId, action: 'seed' });
          purchases.push({ kind: 'seed', qty: 1 });
        }
        break;
      case ACTION_WATER_PLANT:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          gardenChanges.push({ plotId: itemId, action: 'water' });
        }
        break;
      case ACTION_HARVEST_PLANT:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          gardenChanges.push({ plotId: itemId, action: 'harvest' });
        }
        break;
      case ACTION_CONSUME_ITEM:
        {
          let itemId = 0;
          [itemId, pos] = readVarint(body, pos);
          inventoryChanges.push({ globalItemId: itemId, delta: -1 });
        }
        break;
      case ACTION_CREDIT_VISIT_FRIEND:
        {
          const [uid, nextPos] = readNetworkUid(body, pos);
          pos = nextPos;
          visitedFriends.push(normalizeNetworkUid(uid));
        }
        break;
      case ACTION_LOCK_INGREDIENT:
        {
          let ids: number[] = [];
          [ids, pos] = readArray(body, pos, (itemPos) => readVarint(body, itemPos));
          let flag = false;
          [flag, pos] = readBool(body, pos);
          lockIngredientChanges.push(...ids.map((globalItemId) => ({ globalItemId, isLocked: flag })));
        }
        break;
      case ACTION_SAVE_FLOOR:
        {
          let tiles: number[] = [];
          [tiles, pos] = readArray(body, pos, (itemPos) => readVarint(body, itemPos));
          floorChanges.push({ floorIndex: 0, tiles });
        }
        break;
      case ACTION_SAVE_FLOORS:
        {
          let floors: FloorData[] = [];
          [floors, pos] = readArray(body, pos, (itemPos) => readFloor(body, itemPos));
          floorChanges.push(...floors);
        }
        break;
      case ACTION_HIRE_EMPLOYEE:
      case ACTION_UPDATE_EMPLOYEE:
      case ACTION_FIRE_EMPLOYEE:
        {
          let employees: EmployeeData[] = [];
          [employees, pos] = readArray(body, pos, (itemPos) => readEmployee(body, itemPos, action === ACTION_FIRE_EMPLOYEE));
          employeeChanges.push(...employees);
        }
        break;
      case ACTION_MOVE_IN_GAME_ITEMS_TO_INVENTORY:
        {
          let floorIndex = 0;
          [floorIndex, pos] = readVarint(body, pos);
          let itemTypeId = 0;
          [itemTypeId, pos] = readVarint(body, pos);
          bulkInventoryMoves.push({ floorIndex, itemTypeId });
        }
        break;
      default:
        pos = skipAuditPayload(body, pos, action);
        break;
    }
  }

  return {
    creditDelta,
    newCredits,
    upsertOwnedItems,
    removeOwnedItemIds,
    inventoryChanges,
    bulkInventoryMoves,
    ingredientChanges,
    lockIngredientChanges,
    gardenChanges,
    floorChanges,
    employeeChanges,
    openMailIds,
    deleteMailIds,
    visitedFriends,
    purchases,
    actionCount: count,
    unknownActionCount,
    actionTypeCounts,
  };
}

function readOwnedItem(body: Buffer, pos: number): [OwnedItemData, number] {
  let serverId = 0;
  [serverId, pos] = readIntvar32(body, pos);

  let globalItemId = 0;
  [globalItemId, pos] = readVarint(body, pos);

  let positionX = 0;
  [positionX, pos] = readIntvar32(body, pos);

  let positionY = 0;
  [positionY, pos] = readIntvar32(body, pos);

  let data = 0;
  [data, pos] = readU8(body, pos);

  const [employee, afterEmployee] = readNetworkUid(body, pos);
  pos = afterEmployee;

  let roomIndex = 0;
  [roomIndex, pos] = readU8(body, pos);

  return [{
    serverId,
    globalItemId,
    positionX,
    positionY,
    data,
    roomIndex,
    employee: normalizeNetworkUid(employee),
  }, pos];
}

function readInventoryItem(body: Buffer, pos: number): [InventoryItemData & { number: number; isSelected: boolean }, number] {
  let globalItemId = 0;
  [globalItemId, pos] = readVarint(body, pos);

  let number = 0;
  [number, pos] = readVarint(body, pos);

  let isSelected = false;
  [isSelected, pos] = readBool(body, pos);

  return [{ globalItemId, number, delta: number, isSelected, selected: isSelected }, pos];
}

function readEmployee(body: Buffer, pos: number, remove: boolean): [EmployeeData, number] {
  const [id, afterId] = readNetworkUid(body, pos);
  pos = afterId;

  let happiness = 0;
  [happiness, pos] = readVarint(body, pos);

  let task = 0;
  [task, pos] = readU8(body, pos);

  let notify = false;
  [notify, pos] = readBool(body, pos);

  return [{ id: normalizeNetworkUid(id), happiness, task, notify, remove }, pos];
}

function readFloor(body: Buffer, pos: number): [FloorData, number] {
  let floorIndex = 0;
  [floorIndex, pos] = readVarint(body, pos);

  let tiles: number[] = [];
  [tiles, pos] = readArray(body, pos, (itemPos) => readVarint(body, itemPos));

  return [{ floorIndex, tiles }, pos];
}

function skipAuditPayload(body: Buffer, pos: number, action: number): number {
  switch (action) {
    case ACTION_HIRE_EMPLOYEE:
    case ACTION_UPDATE_EMPLOYEE:
    case ACTION_FIRE_EMPLOYEE:
      return skipArray(body, pos, (itemPos) => skipEmployee(body, itemPos));
    case ACTION_LOCK_INGREDIENT:
      pos = skipArray(body, pos, (itemPos) => skipVarint(body, itemPos));
      return skipBool(body, pos);
    case ACTION_SAVE_FLOOR:
      return skipArray(body, pos, (itemPos) => skipVarint(body, itemPos));
    case ACTION_SAVE_FLOORS:
      return skipArray(body, pos, (itemPos) => skipFloor(body, itemPos));
    case ACTION_PURCHASE_PERKS:
      [, pos] = readString(body, pos);
      return skipVarint(body, pos);
    case ACTION_SELL_INVENTORY_ITEM:
      [, pos] = readString(body, pos);
      return skipInventoryItem(body, pos);
    case ACTION_OPEN_MAIL:
    case ACTION_DELETE_MAIL:
      return skipArray(body, pos, (itemPos) => skipVarint(body, itemPos));
    case ACTION_ADD_RECIPE:
      [, pos] = readString(body, pos);
      return pos;
    case ACTION_LVL_UPDATE:
    case ACTION_SEED_PLANT:
    case ACTION_WATER_PLANT:
    case ACTION_HARVEST_PLANT:
    case ACTION_CONSUME_ITEM:
      return skipVarint(body, pos);
    case ACTION_PURCHASE_INGREDIENT:
    case ACTION_SELECT_RECIPE:
      pos = skipVarint(body, pos);
      return action === ACTION_SELECT_RECIPE ? skipBool(body, pos) : skipVarint(body, pos);
    case ACTION_CREDIT_VISIT_FRIEND:
      [, pos] = readNetworkUid(body, pos);
      return pos;
    case ACTION_MOVE_IN_GAME_ITEMS_TO_INVENTORY:
      pos = skipVarint(body, pos);
      return skipVarint(body, pos);
    default:
      return pos;
  }
}

function skipEmployee(body: Buffer, pos: number): number {
  [, pos] = readNetworkUid(body, pos);
  pos = skipVarint(body, pos);
  pos = skipU8(body, pos);
  return skipBool(body, pos);
}

function skipInventoryItem(body: Buffer, pos: number): number {
  pos = skipVarint(body, pos);
  pos = skipVarint(body, pos);
  return skipBool(body, pos);
}

function skipFloor(body: Buffer, pos: number): number {
  pos = skipVarint(body, pos);
  return skipArray(body, pos, (itemPos) => skipVarint(body, itemPos));
}

function skipArray(body: Buffer, pos: number, skipItem: (itemPos: number) => number): number {
  let count = 0;
  [count, pos] = readVarint(body, pos);

  for (let i = 0; i < count; i += 1) {
    pos = skipItem(pos);
  }

  return pos;
}

function skipVarint(body: Buffer, pos: number): number {
  [, pos] = readVarint(body, pos);
  return pos;
}

function skipU8(body: Buffer, pos: number): number {
  [, pos] = readU8(body, pos);
  return pos;
}

function skipBool(body: Buffer, pos: number): number {
  [, pos] = readBool(body, pos);
  return pos;
}

function normalizeNetworkUid(value: NetworkUidData): NetworkUidData {
  return {
    network: value.network,
    networkUid: value.networkUid,
    playfishUid: value.playfishUid,
  };
}

function itemIdFromToken(token: string): number {
  const match = String(token).match(/\d+/);
  return match ? Number.parseInt(match[0] ?? '0', 10) : 0;
}
