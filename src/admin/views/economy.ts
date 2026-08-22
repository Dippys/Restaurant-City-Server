// Economy: pricepoints, purchasable items, ingredient market.
import { api } from '../api.js';
import { also, confirmDialog, ensureCatalogDatalist, esc, fmt, h, itemIdToText, openModal, renderForm, table, toast, type FieldSpec } from '../ui.js';
import type { EconomyResponse } from '../types.js';

type EconomyRow = EconomyResponse['economy']['pricepoints'][number] | EconomyResponse['economy']['purchasableItems'][number] | EconomyResponse['economy']['ingredientMarketItems'][number];

export async function render(container: HTMLElement): Promise<void> {
  // Item-name lookups (ingredient market rows) need the catalogue.
  try {
    ensureCatalogDatalist((await api.catalog()).items);
  } catch {
    // non-fatal: raw ids still work
  }
  container.textContent = 'Loading…';
  let data: EconomyResponse;
  try {
    data = await api.economy();
  } catch (error) {
    container.textContent = '';
    container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
    return;
  }

  container.textContent = '';
  container.append(
    h('h1', { class: 'rc-title' }, 'Economy'),
    h('p', { class: 'rc-sub' }, 'Shop prices, cash items and the ingredient market the game serves.'),

    economyPanel('Pricepoints', data.economy.pricepoints, PRICEPOINT_FIELDS,
      (item) => [fmt(item.productType), fmt(item.payoutParameter), fmt(item.paymentProvider), fmt(item.price), esc(item.currency), fmt(item.currencyScale), esc(item.token), enabledText(item.enabled)],
      (item) => ({ ...item }),
      (key) => String(key.id),
      (values) => api.upsertPricepoint(null, values as never),
      (key, values) => api.upsertPricepoint(Number(key), values as never),
      (key) => api.deletePricepoint(Number(key)),
    ),

    economyPanel('Purchasable items', data.economy.purchasableItems, PURCHASABLE_FIELDS,
      (item) => [fmt(item.skuId), fmt(item.price), esc(item.currency), esc(item.token), enabledText(item.enabled)],
      (item) => ({ ...item }),
      (key) => String(key.id),
      (values) => api.upsertPurchasableItem(null, values as never),
      (key, values) => api.upsertPurchasableItem(Number(key), values as never),
      (key) => api.deletePurchasableItem(Number(key)),
    ),

    economyPanel('Ingredient market', data.economy.ingredientMarketItems, MARKET_FIELDS,
      (item) => [itemIdToText(item.ingredientId), fmt(item.price), enabledText(item.enabled)],
      (item) => ({ ...item }),
      (key) => String(key.id),
      (values) => api.upsertIngredientMarketItem(null, values as never),
      (key, values) => api.upsertIngredientMarketItem(Number(key), values as never),
      (key) => api.deleteIngredientMarketItem(Number(key)),
    ),
  );
}

function enabledText(enabled: boolean): Node {
  return h('span', { class: `rc-badge ${enabled ? 'ok' : 'err'}` }, enabled ? 'enabled' : 'disabled');
}

function economyPanel<T extends EconomyRow>(
  title: string,
  rows: T[],
  fields: ReadonlyArray<FieldSpec>,
  renderRow: (item: T) => ReadonlyArray<Node | string>,
  valuesOf: (item: T) => Record<string, unknown>,
  keyOf: (item: T) => string | number,
  onCreate: (values: Record<string, unknown>) => Promise<unknown>,
  onUpdate: (id: string | number, values: Record<string, unknown>) => Promise<unknown>,
  onDelete: (id: string | number) => Promise<unknown>,
): HTMLElement {
  const refresh = () => render(document.getElementById('rc-view') as HTMLElement);

  const openEditor = (existing: T | null) => {
    const form = renderForm(fields, existing ? valuesOf(existing) : {}, async (values) => {
      if (existing) {
        await onUpdate(keyOf(existing), values);
      } else {
        await onCreate(values);
      }
      toast(existing ? 'Updated' : 'Created');
      await refresh();
    }, existing ? 'Save changes' : 'Create');
    openModal(existing ? `Edit ${title.toLowerCase()}` : `Create ${title.toLowerCase()}`, form);
  };

  const panel = h('section', { class: 'rc-panel' },
    h('div', { class: 'rc-panel-head' },
      h('h2', {}, title, h('span', { class: 'rc-dim' }, ` ${fmt(rows.length)}`)),
      also(h('button', { class: 'rc-btn small primary', type: 'button' }, '+ Create'), (btn) => btn.addEventListener('click', () => openEditor(null))),
    ),
  );
  panel.append(table(
    [...columnsFor(title), ''],
    rows.map((item) => [
      ...renderRow(item),
      h('span', { class: 'rc-row-actions' },
        also(h('button', { class: 'rc-btn small', type: 'button' }, 'Edit'), (btn) => btn.addEventListener('click', () => openEditor(item))),
        also(h('button', { class: 'rc-btn small danger', type: 'button' }, 'Delete'), (btn) => {
          btn.addEventListener('click', async () => {
            if (!(await confirmDialog('Delete?', `Remove ${title.toLowerCase()} entry ${keyOf(item)}?`, true))) return;
            await onDelete(keyOf(item));
            toast('Deleted');
            await refresh();
          });
        }),
      ),
    ]),
  ));
  return panel;
}

function columnsFor(title: string): string[] {
  if (title === 'Pricepoints') return ['Product', 'Payout', 'Provider', 'Price', 'Currency', 'Scale', 'Token', 'State'];
  if (title === 'Purchasable items') return ['SKU', 'Price', 'Currency', 'Token', 'State'];
  return ['Ingredient', 'Price', 'State'];
}

const PRICEPOINT_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: 'productType', label: 'Product type', type: 'number', min: 0, required: true },
  { key: 'payoutParameter', label: 'Payout parameter', type: 'number', min: 0, required: true },
  { key: 'paymentProvider', label: 'Payment provider', type: 'number', min: 0, required: true },
  { key: 'price', label: 'Price', type: 'number', min: 0, required: true },
  { key: 'currency', label: 'Currency', type: 'text', placeholder: 'USD' },
  { key: 'currencyScale', label: 'Currency scale', type: 'number', min: 0, max: 9, required: true },
  { key: 'token', label: 'Token', type: 'text', required: true, help: 'Letters, numbers, dots, dashes, colons.' },
  { key: 'clientData', label: 'Client data', type: 'text' },
  { key: 'enabled', label: 'Enabled', type: 'bool' },
];

const PURCHASABLE_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: 'skuId', label: 'SKU id', type: 'number', min: 1, required: true },
  { key: 'price', label: 'Price', type: 'number', min: 0, required: true },
  { key: 'currency', label: 'Currency', type: 'text', placeholder: 'PFC' },
  { key: 'token', label: 'Token', type: 'text', required: true },
  { key: 'enabled', label: 'Enabled', type: 'bool' },
];

const MARKET_FIELDS: ReadonlyArray<FieldSpec> = [
  { key: 'ingredientId', label: 'Ingredient', type: 'item', placeholder: 'e.g. Apple', help: 'Type an ingredient name, or pick from the suggestions.' },
  { key: 'price', label: 'Price', type: 'number', min: 0, required: true },
  { key: 'enabled', label: 'Enabled', type: 'bool' },
];
