// Game tools: live alerts, online players, quick mail, danger zone.
import { api } from '../api.js';
import { also, buildMultiPlayerPicker, confirmDialog, ensureCatalogDatalist, ensurePlayerDatalist, fmt, h, openModal, relTime, renderForm, table, toast } from '../ui.js';
export async function render(container) {
    // Item-name lookups (mail attachments) need the catalogue.
    try {
        ensureCatalogDatalist((await api.catalog()).items);
    }
    catch {
        // non-fatal: raw ids still work
    }
    container.textContent = 'Loading…';
    let online;
    try {
        const response = await api.online();
        online = response.users;
    }
    catch (error) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
        return;
    }
    // ---- live alert ----
    const alertForm = h('form', { class: 'rc-form' });
    const scopeSelect = h('select', { class: 'rc-input' }, h('option', { value: 'global' }, 'All online players'), ...online.map((user) => h('option', { value: user.networkUid }, `${user.username} (${user.networkUid})`)));
    const titleInput = h('input', { class: 'rc-input', type: 'text', maxlength: '80', placeholder: 'Title (defaults to Restaurant City)' });
    const messageInput = h('textarea', { class: 'rc-input', rows: 3, placeholder: 'Alert message (required)' });
    const alertMsg = h('div', { class: 'rc-msg', 'aria-live': 'polite' });
    const alertBtn = h('button', { class: 'rc-btn primary', type: 'submit' }, 'Send live alert');
    alertForm.append(h('label', {}, 'Send to', scopeSelect), h('label', {}, 'Title', titleInput), h('label', {}, 'Message', messageInput), alertMsg, alertBtn);
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
        }
        catch (error) {
            alertMsg.textContent = error instanceof Error ? error.message : String(error);
            alertMsg.className = 'rc-msg error';
        }
        finally {
            alertBtn.disabled = false;
        }
    });
    // ---- online table ----
    const onlineTable = table(['Username', 'Network UID', 'Playfish UID', 'Last seen', 'Events'], online.map((user) => [
        h('b', {}, user.username),
        user.networkUid,
        fmt(user.playfishUid),
        relTime(user.lastSeenUnix),
        `${user.pendingEvents} queued · ${user.inflightEvents} inflight`,
    ]), 'No players online right now.');
    // ---- quick mail ----
    const mailTool = h('div', { class: 'rc-toolbar' }, also(h('button', { class: 'rc-btn', type: 'button' }, 'Send mail to a player…'), (btn) => {
        btn.addEventListener('click', () => void openMailComposer());
    }));
    // ---- daily ingredient sync ----
    const ingredientSyncMessage = h('div', { class: 'rc-msg', 'aria-live': 'polite' });
    const ingredientSyncButton = h('button', { class: 'rc-btn primary', type: 'button' }, 'Force daily ingredient sync');
    ingredientSyncButton.addEventListener('click', async () => {
        const confirmed = await confirmDialog('Force today\'s ingredient sync?', 'If today has no UTC rotation yet, this creates it immediately—even before 12:00 UTC. Existing completed rotations are reapplied without rerolling or reposting.');
        if (!confirmed)
            return;
        ingredientSyncButton.disabled = true;
        ingredientSyncMessage.textContent = 'Syncing today\'s market and Discord announcement…';
        ingredientSyncMessage.className = 'rc-msg';
        try {
            const result = await api.forceDailyIngredientSync();
            const items = result.ingredients.map((ingredient) => `${ingredient.name} (${ingredient.price.toLocaleString()} coins)`).join(', ');
            const action = result.alreadyComplete
                ? 'Already complete; market rows were reconciled and Discord was not posted twice.'
                : result.created
                    ? 'Created today\'s rotation.'
                    : 'Retried today\'s pending sync.';
            ingredientSyncMessage.textContent = `${action} ${items} Discord: ${result.announced ? 'sent' : 'pending (webhook not configured)'}.`;
            ingredientSyncMessage.className = result.announced ? 'rc-msg ok' : 'rc-msg';
            toast('Daily ingredients synchronized');
        }
        catch (error) {
            ingredientSyncMessage.textContent = error instanceof Error ? error.message : String(error);
            ingredientSyncMessage.className = 'rc-msg error';
        }
        finally {
            ingredientSyncButton.disabled = false;
        }
    });
    const ingredientSyncTool = h('div', {}, h('p', {}, 'Create or reconcile today\'s UTC ingredient market and send any pending Discord announcement. Safe to repeat after deployment.'), ingredientSyncButton, ingredientSyncMessage);
    // ---- danger zone ----
    const dangerZone = h('section', { class: 'rc-panel rc-danger' }, h('h2', {}, 'Danger zone'), h('p', {}, 'Reset wipes every player, all items, mail, images and economy rows. There is no undo.'), also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Reset entire database'), (btn) => {
        btn.addEventListener('click', async () => {
            const first = await confirmDialog('Reset the entire database?', 'All players and all data will be permanently deleted.', true);
            if (!first)
                return;
            const second = await confirmDialog('Really sure?', 'This cannot be undone. Type the word "reset" to confirm.', true);
            if (!second)
                return;
            const typed = prompt('Type "reset" to confirm') ?? '';
            if (typed.trim().toLowerCase() !== 'reset') {
                toast('Cancelled — confirmation text did not match.', false);
                return;
            }
            try {
                await api.requestReset();
                toast('Database reset');
                render(container);
            }
            catch (error) {
                toast(error instanceof Error ? error.message : String(error), false);
            }
        });
    }));
    container.textContent = '';
    container.append(h('h1', { class: 'rc-title' }, 'Game tools'), h('p', { class: 'rc-sub' }, 'Talk to players live, deliver mail, and manage server-wide actions.'), h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Live alert')), alertForm), h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Online players')), onlineTable), h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Mail')), mailTool), h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Daily ingredients')), ingredientSyncTool), dangerZone);
}
const MAIL_TYPES = [
    ['1', 1, 'Player message'],
    ['2', 2, 'Food quiz'],
    ['3', 3, 'Playfish / system message'],
    ['4', 4, 'Gift item'],
    ['5', 5, 'Daily ingredient bonus'],
    ['6', 6, 'Ingredient trade request'],
    ['7', 7, 'Coin delivery'],
    ['7-pfc', 7, 'Playfish Cash delivery'],
    ['8', 8, 'Accepted trade notice'],
    ['9', 9, 'Invite-food gift'],
    ['10', 10, 'Food King reward'],
    ['11', 11, 'Fan-page reward'],
    ['13', 13, 'Special-day present / startup message'],
];
async function openMailComposer() {
    try {
        const [usersResponse, catalogResponse] = await Promise.all([api.users(), api.catalog()]);
        const users = usersResponse.users;
        const firstPlayerSender = users.find((user) => user.networkUid !== '1')?.networkUid || '1';
        ensureCatalogDatalist(catalogResponse.items);
        ensurePlayerDatalist(users.map((user) => ({ id: user.networkUid, label: user.fullName || user.firstName || user.networkUid })));
        const host = h('div');
        const scopeSelect = h('select', { class: 'rc-input' }, h('option', { value: 'online' }, 'Online players'), h('option', { value: 'everyone' }, 'Everyone'), h('option', { value: 'specific' }, 'Specific people (multiple)'));
        const scopeLabel = h('label', {}, 'Recipients', scopeSelect, h('small', { class: 'rc-note' }, 'Online uses current live sessions; Everyone uses every enabled player account.'));
        const recipientPicker = buildMultiPlayerPicker();
        const recipientLabel = h('div', { class: 'rc-recipient-field' }, h('label', {}, 'Specific people'), recipientPicker.wrapper, h('small', { class: 'rc-note' }, 'Search by player name or UID, then click a result or press Enter to add it.'));
        recipientLabel.hidden = true;
        const typeSelect = h('select', { class: 'rc-input' }, ...MAIL_TYPES.map(([value, type, label]) => h('option', { value }, `${type} — ${label}`)));
        const typeLabel = h('label', {}, 'Mail type', typeSelect);
        const rebuild = () => {
            const layout = typeSelect.value || '1';
            const type = MAIL_TYPES.find(([value]) => value === layout)?.[1] ?? 1;
            const fields = mailFields(type, layout);
            const systemMailType = [2, 3, 5, 7, 10, 11, 13].includes(type);
            const form = renderForm(fields, { senderNetworkUid: systemMailType ? '1' : firstPlayerSender }, async (values) => {
                const recipients = recipientPicker.selectedIds();
                const result = await api.sendMail({
                    scope: scopeSelect.value,
                    recipientNetworkUids: scopeSelect.value === 'specific' ? recipients : undefined,
                    senderNetworkUid: String(values.senderNetworkUid || '1'),
                    type,
                    message: mailMessage(type, layout, values),
                    globalItemIds: mailItemIds(type, values),
                });
                toast(`Sent ${result.created} mail${result.created === 1 ? '' : 's'}; ${result.liveNotified} delivered live.`);
            }, 'Send mail');
            form.prepend(scopeLabel, recipientLabel, typeLabel);
            host.replaceChildren(form);
        };
        scopeSelect.addEventListener('change', () => {
            recipientLabel.hidden = scopeSelect.value !== 'specific';
        });
        typeSelect.addEventListener('change', rebuild);
        rebuild();
        openModal('Send mail', host);
    }
    catch (error) {
        toast(error instanceof Error ? error.message : String(error), false);
    }
}
function mailFields(type, layout) {
    const sender = {
        key: 'senderNetworkUid', label: 'From', type: 'player', required: true,
        help: 'Player gifts and trades should use a real sender so the game can render their name and portrait. System layouts default to Restaurant City.',
    };
    const item = (key, label, help) => ({ key, label, type: 'item', help });
    const fields = [sender];
    if (type === 1 || type === 3)
        fields.push({ key: 'message', label: 'Message', type: 'textarea', required: true });
    if (type === 4)
        fields.push({ key: 'message', label: 'Gift message', type: 'textarea' }, item('reward1', 'Gift item'));
    if (type === 5) {
        for (let index = 1; index <= 5; index += 1)
            fields.push(item(`reward${index}`, `Ingredient ${index}${index === 1 ? '' : ' (optional)'}`));
    }
    if (type === 6)
        fields.push(item('reward1', 'Sender offers (ingredient)'), item('reward2', 'Recipient offers (ingredient)'));
    if (type === 7 && layout === '7')
        fields.push({ key: 'coins', label: 'Coins', type: 'number', min: 1, max: 999999999, default: 1000, required: true });
    if (layout === '7-pfc')
        fields.push({ key: 'playfishCash', label: 'Playfish Cash', type: 'number', min: 1, max: 999999999, default: 10, required: true });
    if (type === 8)
        fields.push(item('reward1', 'Accepted item'), item('reward2', 'Exchanged item'));
    if (type === 9)
        fields.push(item('reward1', 'Employee food (perk)', 'Choose a perk from the shipped Employee snack group.'));
    if (type === 10 || type === 11) {
        fields.push(item('reward1', type === 10 ? 'Food King reward' : 'Fan-page reward'));
        fields.push({ key: 'message', label: 'Claim/share link (optional)', type: 'text' });
    }
    if (type === 13) {
        fields.push({
            key: 'specialTheme', label: 'Special layout', type: 'select', default: 'CHRISTMAS',
            options: [
                { value: 'CHRISTMAS', label: 'Christmas present' },
                { value: 'VALENTINES', label: "Valentine's present" },
                { value: 'CHINESE_NEW_YEAR', label: 'Chinese New Year present' },
                { value: '3MillionFan', label: '3 Million Fans startup message (leave reward empty)' },
            ],
        });
        fields.push(item('reward1', 'Present item (optional for startup message)'));
    }
    return fields;
}
function mailItemIds(type, values) {
    if (![4, 5, 6, 8, 9, 10, 11, 13].includes(type))
        return [];
    const maximum = type === 5 ? 5 : type === 6 || type === 8 ? 2 : 1;
    const ids = [];
    for (let index = 1; index <= maximum; index += 1) {
        const id = Number(values[`reward${index}`] || 0);
        if (Number.isInteger(id) && id > 0)
            ids.push(id);
    }
    return ids;
}
function mailMessage(type, layout, values) {
    if (layout === '7-pfc')
        return `PFC:${values.playfishCash || ''}`;
    if (type === 7)
        return String(values.coins || '');
    if (type === 13)
        return String(values.specialTheme || 'CHRISTMAS');
    return String(values.message || '');
}
