export const CALL_TYPES: Readonly<Record<number, string>> = {
  0: 'ERROR',
  1: 'init',
  2: 'getAllFriends',
  3: 'getUserProfile',
  4: 'getUsers',
  5: 'saveProfile',
  17: 'swapIngredient',
  19: 'sendMail',
  20: 'getMails',
  25: 'quizzReply',
  32: 'buyMystryBox',
  34: 'storeImage',
  35: 'rankRestaurant',
  36: 'firstTimeVisitFriend',
  37: 'getRandomStreetUsers',
  38: 'getGourmetStreetUsers',
  40: 'purchaseCoinsWithPfCash',
  41: 'purchaseCashItem',
  42: 'purchaseCashItemIngredients',
  43: 'waterFriendGarden',
  44: 'readBookmarkCount',
  45: 'writeBookmarkCount',
  46: 'sendNotification',
  246: 'getPricepoints',
  247: 'pollEvents',
  248: 'getCashBalance',
  249: 'getServerTime',
  250: 'getPurchasableItems',
  251: 'recordGameEvent',
  253: 'getTimeToken0',
  254: 'ping',
  255: 'batchOperation',
};

export function callName(msgType: number | undefined): string {
  if (msgType === undefined) {
    return 'unknown';
  }
  return CALL_TYPES[msgType] || `type_${msgType}`;
}
