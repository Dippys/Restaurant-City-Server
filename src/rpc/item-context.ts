// Spec: decompiled/game/scripts/com/playfish/rpc/cooking/RpcClient.as
// ITEM_CONTEXT_* bits map directly to GameUser item types 1-4.

interface ContextOwnedItem {
  readonly globalItemId: number;
}

export const ITEM_CONTEXT_CLOTHES = 1;
export const ITEM_CONTEXT_RESTAURANT_FACADE = 2;
export const ITEM_CONTEXT_RESTAURANT_INSIDE = 4;
export const ITEM_CONTEXT_INGREDIENT = 8;

export function filterOwnedItemsByContext<T extends ContextOwnedItem>(
  items: readonly T[],
  itemContext: number,
): T[] {
  return items.filter((item) => {
    const itemType = Math.floor(item.globalItemId / 1_000_000);
    if (itemType < 1 || itemType > 4) {
      return false;
    }

    return (itemContext & (1 << (itemType - 1))) !== 0;
  });
}
