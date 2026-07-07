import type { ParsedRequest, ParsedSubRequest } from './codec';
import {
  readString,
  readBool,
  readByteArray,
  readIntvar32,
  readNetworkUid,
  readU8,
  readVarint,
  writeArray,
  writeByteArray,
  writeBool,
  writeDate,
  writeIntvar32,
  writeNetworkUid,
  writeString,
  writeU8,
  writeVarint,
} from './codec';
import type { OwnedItemData, StoredProfile } from '../db/profile-store';
import { getAllFriends as getAllFriendProfiles, getPlayerProfile, getProfiles, savePlayerProfile } from '../db/profile-store';
import { parseSaveProfile } from './save-profile-parser';
import type { ActiveAccount } from '../session';
import {
  bookmarkCount,
  buyMysteryBox,
  cashBalance,
  firstVisitFriend,
  gourmetStreetUsers,
  ingredientMarketItems,
  initSession,
  mailItemIds,
  pollEvents,
  pricepoints,
  purchasableItems,
  purchaseCashIngredients,
  purchaseCashOwnedItem,
  purchaseCoinsWithCash,
  rankRestaurant,
  receivedMails,
  recordGameEvent,
  replyQuiz,
  sendMail,
  sendNotification,
  storeImage,
  streetUsers,
  swapIngredient,
  timeToken,
  waterFriendGarden,
  setBookmarkCount,
  type StoredMail,
} from '../db/rpc-store';

type RpcResponder = (
  request: ParsedRequest | ParsedSubRequest,
  account: ActiveAccount,
) => Buffer | null | Promise<Buffer | null>;

const STATUS_OK = 0;
const SAVE_STATUS_OK = 0;
const EMPLOYEE_MAX_WORK_TIME_MS = 4 * 60 * 60 * 1000;
const GARDEN_GROW_TIME_SECONDS = 48 * 60 * 60;
const GARDEN_MAX_WETNESS_SECONDS = 9 * 60 * 60;

function writeIngredientMarketItem(ingredientId: number, price: number): Buffer {
  return Buffer.concat([writeVarint(ingredientId), writeVarint(price)]);
}

function writeOwnedItem(item: StoredProfile['ownedItems'][number]): Buffer {
  return Buffer.concat([
    writeIntvar32(item.serverId),
    writeVarint(item.globalItemId),
    writeIntvar32(item.positionX),
    writeIntvar32(item.positionY),
    writeU8(item.data),
    writeNetworkUid(item.employeeNetwork, item.employeeNetworkUid, item.employeePlayfishUid),
    writeU8(item.roomIndex),
  ]);
}

function writeInventoryItem(item: { globalItemId: number; number: number; isSelected: boolean }): Buffer {
  return Buffer.concat([
    writeVarint(item.globalItemId),
    writeVarint(item.number),
    writeBool(item.isSelected),
  ]);
}

function writeIngredient(item: { globalItemId: number; isLocked: boolean; number: number }): Buffer {
  return Buffer.concat([
    writeVarint(item.globalItemId),
    writeBool(item.isLocked),
    writeVarint(item.number),
  ]);
}

function writeFloor(floor: StoredProfile['floors'][number]): Buffer {
  return Buffer.concat([
    writeVarint(floor.floorIndex),
    writeArray(readJsonNumberArray(floor.tilesJson).map(writeVarint)),
  ]);
}

function writeEmployee(employee: StoredProfile['employees'][number]): Buffer {
  return Buffer.concat([
    writeNetworkUid(employee.network, employee.networkUid, employee.playfishUid),
    writeVarint(boundedWorkTime(employee.happiness)),
    writeU8(employee.task),
    writeBool(employee.notify),
    writeArray([]),
  ]);
}

function boundedWorkTime(value: number): number {
  return boundedInt(value, 0, EMPLOYEE_MAX_WORK_TIME_MS, EMPLOYEE_MAX_WORK_TIME_MS);
}

function writePlot(plot: StoredProfile['gardenPlots'][number]): Buffer {
  const elapsedSincePlanted = elapsedSeconds(plot.createdAt);
  const elapsedSinceWatered = elapsedSeconds(plot.updatedAt);
  const baseGrowth = boundedInt(plot.plantWetTime, 0, GARDEN_GROW_TIME_SECONDS, 0);
  const baseWetness = boundedInt(plot.timeToDry, 0, GARDEN_MAX_WETNESS_SECONDS, 0);

  return Buffer.concat([
    writeU8(plot.plotId),
    writeVarint(plot.ingredientId),
    writeVarint(Math.min(GARDEN_GROW_TIME_SECONDS, baseGrowth + elapsedSincePlanted)),
    writeVarint(Math.max(0, baseWetness - elapsedSinceWatered)),
  ]);
}

function writeMail(mail: StoredMail): Buffer {
  return Buffer.concat([
    writeVarint(mail.id),
    writeNetworkUid(mail.senderNetwork, mail.senderNetworkUid, mail.senderPlayfishUid),
    writeArray(mailItemIds(mail).map(writeVarint)),
    writeString(mail.message),
    writeBool(mail.read),
    writeDate(mail.sendDate),
    writeU8(mail.deleteTime),
    writeU8(mail.type),
  ]);
}

function writeProfile(profile: StoredProfile, includeFullState: boolean): Buffer {
  const userLevel = boundedInt(profile.userLevel, 1, 99, 1);
  const activeFloorIndex = boundedInt(profile.activeFloorIndex, 0, 8, 0);
  const parts = [
    writeNetworkUid(profile.network, profile.networkUid, profile.playfishUid),
    writeU8(includeFullState ? 5 : 2),
    writeBool(false),
    writeString(profile.firstName),
    writeString(profile.fullName),
    writeString(profile.imageUrl),
    writeString(profile.largeImageUrl),
    writeU8(profile.gender),
    writeString(profile.restaurantName),
    writeVarint(profile.credits),
    writeIntvar32(profile.playCount),
    writeVarint(profile.gourmetPoint),
    writeVarint(profile.nbVote),
    writeVarint(profile.totalMark),
    writeVarint(profile.trashPoint),
    writeVarint(profile.demandPoint),
    writeVarint(profile.musicPlay),
    writeBool(profile.isInStreet),
    writeVarint(elapsedSinceLastSave(profile.lastSave)),
    writeDate(profile.lastSurveyTime),
    writeBool(Boolean(profile.awards)),
    ...(profile.awards ? [writeByteArray(Buffer.from(profile.awards))] : []),
    writeU8(userLevel),
    writeU8(profile.consecutionCount),
  ];

  if (!includeFullState) {
    return Buffer.concat(parts);
  }

  const activeFloor = profile.floors.find((floor) => floor.floorIndex === activeFloorIndex);
  const visitedToday = todayVisited(profile);

  return Buffer.concat([
    ...parts,
    writeArray(profile.ownedItems.map(writeOwnedItem)),
    writeBool(Boolean(activeFloor)),
    ...(activeFloor ? [writeArray(readJsonNumberArray(activeFloor.tilesJson).map(writeVarint))] : []),
    writeArray(profile.floors.map(writeFloor)),
    writeU8(activeFloorIndex),
    writeArray(profile.employees.map(writeEmployee)),
    writeArray(profile.ingredients.map(writeIngredient)),
    writeBool(true),
    writeArray(profile.gardenPlots.map(writePlot)),
    writeArray(profile.inventoryItems.map(writeInventoryItem)),
    writeArray(profile.visits.map((visit) => writeNetworkUid(visit.friendNetwork, visit.friendNetworkUid, visit.friendPlayfishUid))),
    writeArray(visitedToday.map((visit) => writeNetworkUid(visit.friendNetwork, visit.friendNetworkUid, visit.friendPlayfishUid))),
  ]);
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }

  return value;
}

function elapsedSinceLastSave(lastSaveUnixSeconds: number): number {
  if (!Number.isInteger(lastSaveUnixSeconds) || lastSaveUnixSeconds <= 0) {
    return 0;
  }

  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, now - lastSaveUnixSeconds);
}

async function getUserProfile(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const profile = await getPlayerProfile(account);
  const marketItems = await ingredientMarketItems();

  return Buffer.concat([
    writeProfile(profile, true),
    writeArray(marketItems.map((item) => writeIngredientMarketItem(item.ingredientId, item.price))),
  ]);
}

async function initResponder(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  await initSession(account);
  return writeString('');
}

async function getAllFriends(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const friends = await getAllFriendProfiles(account.networkUid);
  return writeArray(friends.map((profile) => writeProfile(profile, false)));
}

async function getUsers(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const requestedIds = readRequestedUserIds(requestBody(request));
  const users = await getProfiles(requestedIds.map(String), account.networkUid);
  return writeArray(users.map((profile) => writeProfile(profile, true)));
}

async function readBookmarkCountForAccount(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const count = await bookmarkCount(account);
  return Buffer.concat([
    writeU8(STATUS_OK),
    writeIntvar32(count),
  ]);
}

async function saveProfile(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const { profile, audit } = parseSaveProfile(requestBody(request));
  const savedVersion = await savePlayerProfile({
    ...profile,
    id: {
      network: profile.id.network || 2,
      networkUid: account.networkUid,
      playfishUid: account.playfishUid,
    },
  }, audit);

  return Buffer.concat([
    writeU8(SAVE_STATUS_OK),
    writeVarint(savedVersion),
    writeArray([]),
    writeBool(false),
    writeVarint(0),
    writeArray([]),
  ]);
}

async function purchaseCoinsWithPfCash(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const [token] = readToken(requestBody(request));
  const result = await purchaseCoinsWithCash(account, token);
  return Buffer.concat([
    writeU8(result.status),
    writeVarint(result.balance),
  ]);
}

async function purchaseCashItem(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const { token, item } = readPurchaseCashItem(requestBody(request));
  const result = await purchaseCashOwnedItem(account, token, item);
  return Buffer.concat([
    writeU8(result.status),
    writeVarint(result.balance),
  ]);
}

async function purchaseCashItemIngredients(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const tokens = readStringArray(requestBody(request));
  const result = await purchaseCashIngredients(account, tokens);
  return Buffer.concat([
    writeU8(result.status),
    writeVarint(result.balance),
  ]);
}

async function writeBookmarkCountForAccount(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const body = requestBody(request);
  let count = 0;
  [count] = readIntvar32(body, 0);
  return writeU8(await setBookmarkCount(account, count));
}

async function getMails(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const mails = await receivedMails(account);
  return writeArray(mails.map(writeMail));
}

async function getPricepoints(): Promise<Buffer> {
  const items = await pricepoints();
  return Buffer.concat([
    writeBool(false),
    writeArray(items.map((item) => Buffer.concat([
      writeVarint(item.productType),
      writeVarint(item.payoutParameter),
      writeVarint(item.paymentProvider),
      writeVarint(item.price),
      writeString(item.currency),
      writeVarint(item.currencyScale),
      writeString(item.clientData),
      writeString(item.token),
    ]))),
  ]);
}

async function getPurchasableItems(): Promise<Buffer> {
  const items = await purchasableItems();
  return writeArray(items.map((item) => Buffer.concat([
    writeVarint(item.skuId),
    writeVarint(item.price),
    writeString(item.currency),
    writeString(item.token),
  ])));
}

async function getCashBalance(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  return writeVarint(await cashBalance(account));
}

async function storeImageResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const { imageType, data, width, height } = readStoreImage(requestBody(request));
  return writeU8(await storeImage(account, imageType, data, width, height));
}

async function rankRestaurantResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const { target, rating } = readRankRestaurant(requestBody(request));
  return writeU8(await rankRestaurant(account, target, rating));
}

async function firstTimeVisitFriendResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const [target] = readNetworkUid(requestBody(request), 0);
  const result = await firstVisitFriend(account, target);
  return Buffer.concat([
    writeU8(result.status),
    writeInventoryItem(result.gift),
  ]);
}

async function getRandomStreetUsers(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const [count] = readVarint(requestBody(request), 0);
  const users = await streetUsers(account, count);
  return writeArray(users.map((profile) => writeProfile(profile, true)));
}

async function getGourmetStreetUsers(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const [count] = readVarint(requestBody(request), 0);
  const users = await gourmetStreetUsers(account, count);
  return writeArray(users.map((profile) => writeProfile(profile, true)));
}

async function swapIngredientResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const parsed = readSwapIngredient(requestBody(request));
  return writeU8(await swapIngredient(account, parsed.target, parsed.offeredToken, parsed.requestedToken));
}

async function sendMailResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const mail = readSendMail(requestBody(request));
  return writeU8(await sendMail(account, mail));
}

async function replyQuizResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const parsed = readReplyQuiz(requestBody(request));
  return writeVarint(await replyQuiz(account, parsed.quizId, parsed.answer, parsed.correct));
}

async function buyMysteryBoxResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const parsed = readMysteryBox(requestBody(request));
  return writeVarint(await buyMysteryBox(account, parsed.category, parsed.tokens));
}

async function waterFriendGardenResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const parsed = readWaterFriendGarden(requestBody(request));
  return writeU8(await waterFriendGarden(account, parsed.friend, parsed.plotOwner, parsed.plotId));
}

async function sendNotificationResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const [recipient] = readNetworkUid(requestBody(request), 0);
  return writeU8(await sendNotification(account, recipient));
}

async function recordGameEventResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const parsed = readGameEvent(requestBody(request));
  await recordGameEvent(account, parsed.eventType, parsed.eventText);
  return Buffer.alloc(0);
}

async function pollEventsResponder(request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  const result = await pollEvents(account, readPollRequest(requestBody(request)));
  return Buffer.concat([
    writeVarint(result.minPollInterval),
    writeVarint(result.requestTimeout),
    writeArray([]),
  ]);
}

async function getTimeToken(_request: ParsedRequest | ParsedSubRequest, account: ActiveAccount): Promise<Buffer> {
  return writeByteArray(await timeToken(account));
}

function requestBody(request: ParsedRequest | ParsedSubRequest): Buffer {
  return 'body' in request ? request.body : (request.args ?? Buffer.alloc(0));
}

function readToken(body: Buffer): [string, number] {
  return readString(body, 0);
}

function readPurchaseCashItem(body: Buffer): { token: string; item: OwnedItemData } {
  let pos = 0;
  let token = '';
  [token, pos] = readString(body, pos);
  [, pos] = readVarint(body, pos);
  const [item] = readOwnedItemBody(body, pos);
  return { token, item };
}

function readOwnedItemBody(body: Buffer, pos: number): [OwnedItemData, number] {
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
  return [ownedItemData(serverId, globalItemId, positionX, positionY, data, employee, roomIndex), pos];
}

function ownedItemData(
  serverId: number,
  globalItemId: number,
  positionX: number,
  positionY: number,
  data: number,
  employee: { network: number; networkUid: string; playfishUid: number },
  roomIndex: number,
) {
  return {
    serverId,
    globalItemId,
    positionX,
    positionY,
    data,
    employee,
    roomIndex,
  };
}

function readStringArray(body: Buffer): string[] {
  let pos = 0;
  let count = 0;
  [count, pos] = readVarint(body, pos);
  const values: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = '';
    [value, pos] = readString(body, pos);
    values.push(value);
  }
  return values;
}

function readStoreImage(body: Buffer): { imageType: number; data: Buffer; width: number; height: number } {
  let pos = 0;
  let imageType = 0;
  [imageType, pos] = readVarint(body, pos);
  let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  [data, pos] = readByteArray(body, pos);
  let width = 0;
  [width, pos] = readVarint(body, pos);
  let height = 0;
  [height] = readVarint(body, pos);
  return { imageType, data, width, height };
}

function readRankRestaurant(body: Buffer) {
  let pos = 0;
  const [target, afterTarget] = readNetworkUid(body, pos);
  pos = afterTarget;
  let rating = 0;
  [rating] = readU8(body, pos);
  return { target, rating };
}

function readSwapIngredient(body: Buffer) {
  let pos = 0;
  const [target, afterTarget] = readNetworkUid(body, pos);
  pos = afterTarget;
  let offeredToken = '';
  [offeredToken, pos] = readString(body, pos);
  let requestedToken = '';
  [requestedToken, pos] = readString(body, pos);
  [, pos] = readBool(body, pos);
  [, pos] = readVarint(body, pos);
  [, pos] = readBool(body, pos);
  return { target, offeredToken, requestedToken };
}

function readSendMail(body: Buffer) {
  let pos = 0;
  const [recipient, afterRecipient] = readNetworkUid(body, pos);
  pos = afterRecipient;
  let globalItemIds: number[] = [];
  [globalItemIds, pos] = readNumberArray(body, pos);
  let itemId = 0;
  [itemId, pos] = readIntvar32(body, pos);
  let message = '';
  [message, pos] = readString(body, pos);
  let type = 0;
  [type] = readU8(body, pos);
  return { recipient, globalItemIds, itemId, message, type };
}

function readReplyQuiz(body: Buffer) {
  let pos = 0;
  let quizId = 0;
  [quizId, pos] = readVarint(body, pos);
  let answer = '';
  [answer, pos] = readString(body, pos);
  let correct = false;
  [correct] = readBool(body, pos);
  return { quizId, answer, correct };
}

function readMysteryBox(body: Buffer) {
  let pos = 0;
  let category = '';
  [category, pos] = readString(body, pos);
  let tokens: string[] = [];
  [tokens] = readStringArrayAt(body, pos);
  return { category, tokens };
}

function readWaterFriendGarden(body: Buffer) {
  let pos = 0;
  const [friend, afterFriend] = readNetworkUid(body, pos);
  pos = afterFriend;
  const [plotOwner, afterOwner] = readNetworkUid(body, pos);
  pos = afterOwner;
  let plotId = 0;
  [plotId] = readVarint(body, pos);
  return { friend, plotOwner, plotId };
}

function readGameEvent(body: Buffer) {
  let pos = 0;
  let eventType = 0;
  [eventType, pos] = readU8(body, pos);
  [, pos] = readVarint(body, pos);
  let eventText = '';
  [eventText] = readString(body, pos);
  return { eventType, eventText };
}

function readPollRequest(body: Buffer) {
  try {
    let pos = 0;
    let synchronous = false;
    [synchronous, pos] = readBool(body, pos);
    let requestTimeout = 0;
    [requestTimeout, pos] = readVarint(body, pos);
    let ackEventIds: number[] = [];
    [ackEventIds] = readNumberArray(body, pos);
    return { synchronous, requestTimeout, ackEventIds };
  } catch {
    return { synchronous: false, requestTimeout: 30000, ackEventIds: [] };
  }
}

function readNumberArray(body: Buffer, pos: number): [number[], number] {
  let count = 0;
  [count, pos] = readVarint(body, pos);
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = 0;
    [value, pos] = readVarint(body, pos);
    values.push(value);
  }
  return [values, pos];
}

function readStringArrayAt(body: Buffer, pos: number): [string[], number] {
  let count = 0;
  [count, pos] = readVarint(body, pos);
  const values: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = '';
    [value, pos] = readString(body, pos);
    values.push(value);
  }
  return [values, pos];
}

function readJsonNumberArray(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function todayVisited(profile: StoredProfile): StoredProfile['visits'] {
  const today = new Date().toISOString().slice(0, 10);
  return profile.visits.filter((visit) => visit.visitsTodayDate === today && visit.visitsTodayCount > 0);
}

function elapsedSeconds(value: Date): number {
  const elapsed = Math.floor((Date.now() - value.getTime()) / 1000);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
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
  1: initResponder,
  2: getAllFriends,
  3: getUserProfile,
  4: getUsers,
  5: saveProfile,
  17: swapIngredientResponder,
  19: sendMailResponder,
  20: getMails,
  25: replyQuizResponder,
  32: buyMysteryBoxResponder,
  34: storeImageResponder,
  35: rankRestaurantResponder,
  36: firstTimeVisitFriendResponder,
  37: getRandomStreetUsers,
  38: getGourmetStreetUsers,
  40: purchaseCoinsWithPfCash,
  41: purchaseCashItem,
  42: purchaseCashItemIngredients,
  43: waterFriendGardenResponder,
  44: readBookmarkCountForAccount,
  45: writeBookmarkCountForAccount,
  46: sendNotificationResponder,
  246: getPricepoints,
  247: pollEventsResponder,
  248: getCashBalance,
  249: () => writeDate(Math.floor(Date.now() / 1000)),
  250: getPurchasableItems,
  251: recordGameEventResponder,
  253: getTimeToken,
  254: () => Buffer.alloc(0),
};
