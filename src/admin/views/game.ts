// Game tools: live alerts, online players, quick mail, danger zone.
import { api } from '../api.js';
import { also, confirmDialog, ensureCatalogDatalist, ensurePlayerDatalist, fmt, h, itemListTextToIds, openModal, relTime, renderForm, table, toast } from '../ui.js';
import type { OnlineUser } from '../types.js';

export async function render(container: HTMLElement): Promise<void> {
  // Item-name lookups (mail attachments) need the catalogue.
  try {
    ensureCatalogDatalist((await api.catalog()).items);
  } catch {
    // non-fatal: raw ids still work
  }
  container.textContent = 'Loading…';
  let online: OnlineUser[];
  try {
    const response = await api.online();
    online = response.users;
  } catch (error) {
    container.textContent = '';
    container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
    return;
  }

  // ---- live alert ----
  const alertForm = h('form', { class: 'rc-form' });
  const scopeSelect = h('select', { class: 'rc-input' },
    h('option', { value: 'global' }, 'All online players'),
    ...online.map((user) => h('option', { value: user.networkUid }, `${user.username} (${user.networkUid})`)),
  );
  const titleInput = h('input', { class: 'rc-input', type: 'text', maxlength: '80', placeholder: 'Title (defaults to Restaurant City)' });
  const messageInput = h('textarea', { class: 'rc-input', rows: 3, placeholder: 'Alert message (required)' });
  const alertMsg = h('div', { class: 'rc-msg', 'aria-live': 'polite' });
  const alertBtn = h('button', { class: 'rc-btn primary', type: 'submit' }, 'Send live alert');
  alertForm.append(
    h('label', {}, 'Send to', scopeSelect),
    h('label', {}, 'Title', titleInput),
    h('label', {}, 'Message', messageInput),
    alertMsg,
    alertBtn,
  );
  alertForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = messageInput.value.trim();
    if (!message) {
      alertMsg.textContent = 'Message is required.';
      alertMsg.className = 'rc-msg error';
      return;
    }
    alertBtn.disabled = true;
    try {
      const result = await api.alert({
        scope: scopeSelect.value === 'global' ? 'global' : 'player',
        networkUid: scopeSelect.value === 'global' ? undefined : scopeSelect.value,
        title: titleInput.value.trim() || undefined,
        message,
      });
      alertMsg.textContent = `Delivered to ${result.delivered} player${result.delivered === 1 ? '' : 's'}.`;
      alertMsg.className = 'rc-msg ok';
      messageInput.value = '';
      titleInput.value = '';
    } catch (error) {
      alertMsg.textContent = error instanceof Error ? error.message : String(error);
      alertMsg.className = 'rc-msg error';
    } finally {
      alertBtn.disabled = false;
    }
  });

  // ---- online table ----
  const onlineTable = table(
    ['Username', 'Network UID', 'Playfish UID', 'Last seen', 'Events'],
    online.map((user) => [
      h('b', {}, user.username),
      user.networkUid,
      fmt(user.playfishUid),
      relTime(user.lastSeenUnix),
      `${user.pendingEvents} queued · ${user.inflightEvents} inflight`,
    ]),
    'No players online right now.',
  );

  // ---- quick mail ----
  const mailTool = h('div', { class: 'rc-toolbar' },
    also(h('button', { class: 'rc-btn', type: 'button' }, 'Send mail to a player…'), (btn) => {
      btn.addEventListener('click', () => openMailComposer());
    }),
  );

  // ---- danger zone ----
  const dangerZone = h('section', { class: 'rc-panel rc-danger' },
    h('h2', {}, 'Danger zone'),
    h('p', {}, 'Reset wipes every player, all items, mail, images and economy rows. There is no undo.'),
    also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Reset entire database'), (btn) => {
      btn.addEventListener('click', async () => {
        const first = await confirmDialog('Reset the entire database?', 'All players and all data will be permanently deleted.', true);
        if (!first) return;
        const second = await confirmDialog('Really sure?', 'This cannot be undone. Type the word "reset" to confirm.', true);
        if (!second) return;
        const typed = prompt('Type "reset" to confirm') ?? '';
        if (typed.trim().toLowerCase() !== 'reset') {
          toast('Cancelled — confirmation text did not match.', false);
          return;
        }
        try {
          await api.requestReset();
          toast('Database reset');
          render(container);
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), false);
        }
      });
    }),
  );

  container.textContent = '';
  container.append(
    h('h1', { class: 'rc-title' }, 'Game tools'),
    h('p', { class: 'rc-sub' }, 'Talk to players live, deliver mail, and manage server-wide actions.'),

    h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Live alert')), alertForm),
    h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Online players')), onlineTable),
    h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Mail')), mailTool),
    dangerZone,
  );
}

function openMailComposer(): void {
  // Player picker needs the account list.
  void api
    .users()
    .then((response) => {
      ensurePlayerDatalist(response.users.map((user) => ({ id: user.networkUid, label: user.fullName || user.firstName || user.networkUid })));
    })
    .catch(() => {});
  const form = renderForm(
    [
      { key: 'recipientNetworkUid', label: 'Recipient (player)', type: 'player', required: true, placeholder: 'e.g. Mia Cafe' },
      { key: 'message', label: 'Message', type: 'textarea', required: true },
      { key: 'globalItemIds', label: 'Attached items', type: 'text', help: 'Comma-separated item names or ids, e.g. Apple, Basic Window' },
      { key: 'type', label: 'Mail type', type: 'number', min: 0, max: 255, default: 1 },
    ],
    {},
    async (values) => {
      const ids = itemListTextToIds(String(values.globalItemIds || ''));
      const recipient = String(values.recipientNetworkUid);
      await api.addMail(recipient, {
        recipientNetworkUid: recipient,
        message: String(values.message),
        globalItemIds: ids,
        type: Number(values.type ?? 1),
      });
      toast('Mail sent');
    },
    'Send mail',
  );
  openModal('Send mail', form);
}
