// Users: player list, create, detail with full resource CRUD.
import { api } from '../api.js';
import { also, badge, confirmDialog, esc, ensureCatalogDatalist, ensurePlayerDatalist, fmt, h, isoTime, itemIdToText, itemListTextToIds, openModal, relTime, renderForm, table, toast } from '../ui.js';
let catalog = [];
let players = [];
let listPage = 1;
let listQuery = '';
/** Display name for a player uid: "Mia Cafe (1001)" when known, else the uid. */
function playerLabel(uid) {
    if (!uid)
        return '';
    const player = players.find((candidate) => candidate.networkUid === uid);
    if (!player)
        return uid;
    const name = player.fullName || player.firstName || player.networkUid;
    return `${name} (${uid})`;
}
async function ensureCatalog() {
    if (catalog.length === 0) {
        const response = await api.catalog();
        catalog = response.items;
        ensureCatalogDatalist(catalog);
    }
}
function itemLabel(id) {
    return itemIdToText(id);
}
function itemField(key, label, help = 'Type an item name, or pick from the suggestions.') {
    return { key, label, type: 'item', placeholder: 'e.g. Apple', help };
}
// ---------- list ----------
export async function render(container, params) {
    await ensureCatalog();
    const target = params[0] ? decodeURIComponent(params[0]) : null;
    if (target) {
        await renderDetail(container, target);
        return;
    }
    await renderList(container);
}
async function renderList(container) {
    container.textContent = 'Loading…';
    let users;
    let total = 0;
    let totalPages = 1;
    try {
        const response = await api.users(listPage, 50, listQuery);
        users = response.users;
        listPage = response.page;
        total = response.total;
        totalPages = response.totalPages;
    }
    catch (error) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
        return;
    }
    let searchTimer;
    const toolbar = h('div', { class: 'rc-toolbar' }, h('input', { class: 'rc-input', type: 'search', placeholder: 'search uid / name / restaurant…' }).also((input) => {
        input.value = listQuery;
        input.addEventListener('input', () => {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => {
                listQuery = input.value.trim();
                listPage = 1;
                void renderList(container);
            }, 250);
        });
    }), h('button', { class: 'rc-btn primary', type: 'button' }, '+ Create user').also((btn) => {
        btn.addEventListener('click', () => openCreateUser(() => render(container, [])));
    }), h('span', { class: 'rc-stat' }, `${fmt(total)} players`));
    const listBox = h('div', { class: 'rc-panel' });
    const redraw = () => {
        const visible = users;
        listBox.textContent = '';
        listBox.append(table(['UID', 'Player', 'Restaurant', 'Lv', 'Gourmet', 'Coins', 'Cash', 'Updated', ''], visible.map((user) => [
            user.networkUid,
            h('span', {}, h('b', {}, esc(user.firstName)), h('span', { class: 'rc-dim' }, ` ${esc(user.fullName)}`)),
            esc(user.restaurantName),
            fmt(user.userLevel),
            fmt(user.gourmetPoint),
            fmt(user.credits),
            fmt(user.cashBalance),
            relTime(user.lastSave),
            h('span', { class: 'rc-row-actions' }, also(h('button', { class: 'rc-btn small', type: 'button' }, 'Open'), (btn) => {
                btn.addEventListener('click', () => {
                    window.location.hash = `#/users/${encodeURIComponent(user.networkUid)}`;
                });
            }), impersonateButton(user, true), also(h('button', { class: 'rc-btn small danger', type: 'button' }, 'Delete'), (btn) => {
                btn.addEventListener('click', async () => {
                    if (!(await confirmDialog('Delete player?', `${user.networkUid} (${user.firstName}) and ALL their data (items, mail, images, …) will be deleted permanently.`, true)))
                        return;
                    await api.deleteUser(user.networkUid);
                    toast('Player deleted');
                    render(container, []);
                });
            })),
        ])));
    };
    container.textContent = '';
    const pager = h('div', { class: 'rc-toolbar' }, also(h('button', { class: 'rc-btn small', type: 'button', disabled: listPage <= 1 }, 'Previous'), (button) => {
        button.addEventListener('click', () => { listPage -= 1; void renderList(container); });
    }), h('span', { class: 'rc-stat' }, `Page ${fmt(listPage)} of ${fmt(totalPages)}`), also(h('button', { class: 'rc-btn small', type: 'button', disabled: listPage >= totalPages }, 'Next'), (button) => {
        button.addEventListener('click', () => { listPage += 1; void renderList(container); });
    }));
    container.append(h('h1', { class: 'rc-title' }, 'Players'), toolbar, listBox, pager);
    redraw();
}
function openCreateUser(onDone) {
    const form = renderForm(PROFILE_FIELDS, {}, async (values) => {
        try {
            await api.createUser(values);
            toast('Player created with starter items');
            onDone();
        }
        catch (error) {
            throw error;
        }
    }, 'Create player');
    openModal('Create player', form);
}
// ---------- detail ----------
async function renderDetail(container, networkUid) {
    container.textContent = 'Loading…';
    let user = null;
    try {
        const [response, options] = await Promise.all([api.user(networkUid), api.userOptions()]);
        players = options.users;
        ensurePlayerDatalist(players.map((player) => ({ id: player.networkUid, label: player.fullName || player.firstName || player.networkUid })));
        user = response.user;
    }
    catch (error) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
        return;
    }
    if (!user) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, `Player ${esc(networkUid)} not found.`), also(h('button', { class: 'rc-btn', type: 'button' }, '← Back to players'), (btn) => btn.addEventListener('click', () => (window.location.hash = '#/users'))));
        return;
    }
    const refresh = async () => renderDetail(container, networkUid);
    const fallbackRepair = /^Dummy\d+$/i.test(user.restaurantName.trim())
        ? also(h('button', { class: 'rc-btn primary', type: 'button' }, 'Fix Dummy profile'), (btn) => {
            btn.title = 'Restore the clean profile scalars while preserving the restaurant and inventory data.';
            btn.addEventListener('click', async () => {
                if (!(await confirmDialog('Fix Dummy profile?', 'Restore this player from the clean rollback snapshot. Their placed items, recipes, ingredients, floors, garden, mail, and employees will be preserved.', false)))
                    return;
                btn.disabled = true;
                try {
                    await api.fixFallbackPlayer(user.networkUid);
                    toast('Profile fixed; gameplay state preserved');
                    await refresh();
                }
                catch (error) {
                    btn.disabled = false;
                    toast(error instanceof Error ? error.message : String(error), false);
                }
            });
        })
        : null;
    const rebuildSave = also(h('button', { class: 'rc-btn primary', type: 'button' }, 'Rebuild save'), (btn) => {
        btn.title = 'Re-read and checkpoint this player from the stored restaurant data.';
        btn.addEventListener('click', async () => {
            if (!(await confirmDialog('Rebuild player save?', 'Rebuild the client-facing save from the stored profile, items, inventory, ingredients, floors, garden, mail, and employees. No gameplay collections will be reset.', false)))
                return;
            btn.disabled = true;
            try {
                await api.rebuildPlayerSave(user.networkUid);
                toast('Save rebuilt; refresh the game session');
                await refresh();
            }
            catch (error) {
                btn.disabled = false;
                toast(error instanceof Error ? error.message : String(error), false);
            }
        });
    });
    const header = h('section', { class: 'rc-panel rc-profile' }, h('div', { class: 'rc-profile-id' }, h('h1', { class: 'rc-title' }, esc(user.firstName), h('span', { class: 'rc-dim' }, ` ${esc(user.fullName)}`)), h('p', { class: 'rc-sub' }, `UID ${user.networkUid} · playfish ${fmt(user.playfishUid)} · ${esc(user.restaurantName)}`), h('div', { class: 'rc-badges' }, badge(`Lv ${user.userLevel}`, 'ok'), badge(user.isInStreet ? 'in street' : 'in restaurant', 'muted'), badge(user.activeFloorIndex > 0 ? `floor ${user.activeFloorIndex}` : 'ground floor', 'muted'), badge(`${fmt(user.credits)} coins`, 'ok'), badge(`${fmt(user.cashBalance)} cash`, 'warn'), badge(`${fmt(user.gourmetPoint)} gourmet`, 'muted'), badge(`play count ${fmt(user.playCount)}`, 'muted'), badge(`updated ${relTime(Math.floor(new Date(user.updatedAt).getTime() / 1000))}`, 'muted'))), h('div', { class: 'rc-row-actions' }, impersonateButton(user), fallbackRepair, rebuildSave, also(h('button', { class: 'rc-btn', type: 'button' }, 'Edit profile'), (btn) => {
        btn.addEventListener('click', () => openProfileEditor(user, refresh));
    }), also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Delete player'), (btn) => {
        btn.addEventListener('click', async () => {
            if (!(await confirmDialog('Delete player?', `${user.networkUid} and all their data will be deleted permanently.`, true)))
                return;
            await api.deleteUser(user.networkUid);
            toast('Player deleted');
            window.location.hash = '#/users';
        });
    })));
    const sections = h('div', { class: 'rc-grid' });
    sections.append(crudSection({
        title: 'Owned items (placed)', data: user.ownedItems, refresh,
        headers: ['Item', 'X', 'Y', 'Data', 'Room', 'Employee'],
        renderRow: (item) => [itemLabel(item.globalItemId), fmt(item.positionX), fmt(item.positionY), fmt(item.data), fmt(item.roomIndex), item.employeeNetworkUid || fmt(item.employeeNetwork)],
        fields: OWNED_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.serverId),
        onAdd: (values) => api.addOwnedItem(user.networkUid, values),
        onUpdate: (key, values) => api.updateOwnedItem(user.networkUid, Number(key), values),
        onDelete: (key) => api.deleteOwnedItem(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Inventory (recipes)', data: user.inventoryItems, refresh,
        headers: ['Item', 'Count', 'Selected'],
        renderRow: (item) => [itemLabel(item.globalItemId), fmt(item.number), item.isSelected ? '✓' : ''],
        fields: INVENTORY_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.globalItemId),
        onAdd: (values) => api.addInventory(user.networkUid, values),
        onUpdate: (key, values) => api.updateInventory(user.networkUid, Number(key), values),
        onDelete: (key) => api.deleteInventory(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Ingredients', data: user.ingredients, refresh,
        headers: ['Ingredient', 'Count', 'Locked'],
        renderRow: (item) => [itemLabel(item.globalItemId), fmt(item.number), item.isLocked ? '🔒' : ''],
        fields: INGREDIENT_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.globalItemId),
        onAdd: (values) => api.addIngredient(user.networkUid, values),
        onUpdate: (key, values) => api.updateIngredient(user.networkUid, Number(key), values),
        onDelete: (key) => api.deleteIngredient(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Garden plots', data: user.gardenPlots, refresh,
        headers: ['Plot', 'Ingredient', 'Wet time', 'Dry in'],
        renderRow: (item) => [fmt(item.plotId), itemLabel(item.ingredientId), fmt(item.plantWetTime), fmt(item.timeToDry)],
        fields: GARDEN_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.plotId),
        onAdd: (values) => api.addGardenPlot(user.networkUid, values),
        onUpdate: (key, values) => api.updateGardenPlot(user.networkUid, Number(key), values),
        onDelete: (key) => api.deleteGardenPlot(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Floors', data: user.floors, refresh,
        headers: ['Floor', 'Tiles', 'Tiles JSON'],
        renderRow: (item) => {
            let tileCount = 0;
            try {
                tileCount = JSON.parse(item.tilesJson).length;
            }
            catch {
                tileCount = 0;
            }
            return [fmt(item.floorIndex), fmt(tileCount), esc(item.tilesJson.slice(0, 80))];
        },
        fields: FLOOR_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.floorIndex),
        onAdd: (values) => api.addFloor(user.networkUid, { floorIndex: Number(values.floorIndex), tilesJson: String(values.tilesJson) }),
        onUpdate: (key, values) => api.updateFloor(user.networkUid, Number(key), { floorIndex: Number(values.floorIndex), tilesJson: String(values.tilesJson) }),
        onDelete: (key) => api.deleteFloor(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Employees', data: user.employees, refresh,
        headers: ['Employee', 'Happiness', 'Task', 'Notify'],
        renderRow: (item) => [playerLabel(item.networkUid), fmt(item.happiness), fmt(item.task), item.notify ? '✓' : ''],
        fields: EMPLOYEE_FIELDS,
        valuesOf: (item) => ({ ...item, networkUid: playerLabel(item.networkUid) }),
        keyOf: (item) => item.networkUid,
        onAdd: (values) => api.addEmployee(user.networkUid, values),
        onUpdate: (key, values) => api.updateEmployee(user.networkUid, key, values),
        onDelete: (key) => api.deleteEmployee(user.networkUid, key),
    }), crudSection({
        title: 'Mail sent', data: user.mailsSent, refresh,
        headers: ['To', 'Items', 'Message', 'When'],
        renderRow: (item) => [playerLabel(item.recipientNetworkUid), mailItems(item.globalItemIdsJson), esc((item.message || '').slice(0, 60)), relTime(item.sendDate)],
        fields: MAIL_FIELDS,
        valuesOf: (item) => ({ ...item, recipientNetworkUid: playerLabel(item.recipientNetworkUid), globalItemIds: JSON.parse(item.globalItemIdsJson || '[]').join(', ') }),
        keyOf: (item) => String(item.id),
        onAdd: (values) => api.addMail(user.networkUid, parseMailValues(values)),
        onUpdate: (key, values) => api.updateMail(user.networkUid, Number(key), parseMailValues(values)),
        onDelete: (key) => api.deleteMail(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Mail received', data: user.mailsReceived, refresh,
        headers: ['From', 'Items', 'Message', 'When'],
        renderRow: (item) => [playerLabel(item.senderNetworkUid), mailItems(item.globalItemIdsJson), esc((item.message || '').slice(0, 60)), relTime(item.sendDate)],
        fields: MAIL_FIELDS,
        valuesOf: (item) => ({ ...item, senderNetworkUid: playerLabel(item.senderNetworkUid), globalItemIds: JSON.parse(item.globalItemIdsJson || '[]').join(', ') }),
        keyOf: (item) => String(item.id),
        onAdd: (values) => api.addMail(user.networkUid, parseMailValues(values)),
        onUpdate: (key, values) => api.updateMail(user.networkUid, Number(key), parseMailValues(values)),
        onDelete: (key) => api.deleteMail(user.networkUid, Number(key)),
    }), crudSection({
        title: 'Game events', data: user.gameEvents, refresh,
        headers: ['Type', 'Text', 'When'],
        renderRow: (item) => [fmt(item.eventType), esc(item.eventText.slice(0, 80)), relTime(item.createdAtUnix)],
        fields: EVENT_FIELDS,
        valuesOf: (item) => ({ ...item }),
        keyOf: (item) => String(item.id),
        onAdd: (values) => api.addGameEvent(user.networkUid, values),
        onDelete: (key) => api.deleteGameEvent(user.networkUid, Number(key)),
        noEdit: true,
    }), imagesSection(user), otherRecordsSection(user));
    container.textContent = '';
    container.append(also(h('button', { class: 'rc-btn small', type: 'button' }, '← Back to players'), (btn) => btn.addEventListener('click', () => (window.location.hash = '#/users'))), header, staleIdBanner(user) ?? h('span', { class: 'hidden' }), sections);
}
function impersonateButton(user, small = false) {
    return also(h('button', { class: `rc-btn${small ? ' small' : ''}`, type: 'button' }, 'Impersonate'), (button) => {
        button.title = `Open the game as ${user.fullName || user.firstName || user.networkUid}`;
        button.addEventListener('click', async () => {
            const gameWindow = window.open('', '_blank');
            if (!gameWindow) {
                toast('Allow pop-ups for this site to open an impersonated game.', false);
                return;
            }
            gameWindow.document.title = 'Preparing diagnostic game…';
            gameWindow.document.body.textContent = 'Waiting for administrator confirmation…';
            try {
                const confirmed = await confirmDialog('Impersonate this player?', `The game will load as ${user.fullName || user.firstName || user.networkUid}. Any play or saves affect their real profile, and opening it may displace their currently running game.`, true);
                if (!confirmed) {
                    gameWindow.close();
                    return;
                }
                gameWindow.document.body.textContent = `Opening Restaurant City as ${user.fullName || user.firstName || user.networkUid}…`;
                const result = await api.impersonateUser(user.networkUid);
                gameWindow.opener = null;
                gameWindow.location.replace(result.url);
                toast(`Opened a 30-minute diagnostic session for ${user.firstName || user.networkUid}`);
            }
            catch (error) {
                gameWindow.close();
                toast(error instanceof Error ? error.message : String(error), false);
            }
        });
    });
}
/** Rows whose item ids are not in the current item databases (legacy save data). */
function staleIdBanner(user) {
    const known = new Set(catalog.map((entry) => entry.id));
    const found = [];
    const note = (section, rows) => {
        for (const row of rows) {
            if (!known.has(row.globalItemId))
                found.push({ section, id: row.globalItemId });
        }
    };
    note('Inventory', user.inventoryItems);
    note('Ingredients', user.ingredients);
    note('Owned items', user.ownedItems);
    for (const plot of user.gardenPlots) {
        if (!known.has(plot.ingredientId))
            found.push({ section: 'Garden', id: plot.ingredientId });
    }
    for (const mail of [...user.mailsSent, ...user.mailsReceived]) {
        try {
            for (const id of JSON.parse(mail.globalItemIdsJson || '[]')) {
                if (!known.has(id))
                    found.push({ section: 'Mail', id });
            }
        }
        catch {
            // ignore malformed attachment lists
        }
    }
    if (found.length === 0)
        return null;
    const unique = [...new Map(found.map((entry) => [`${entry.section}:${entry.id}`, entry])).values()];
    return h('div', { class: 'rc-panel rc-warn-banner' }, h('b', {}, `Stale item ids (${unique.length})`), h('p', {}, 'This player has rows whose item ids are not in the current item databases — leftover ids from early saves. They show as "Unknown item" and the game cannot use them. Edit each row (pick a real item from the combobox) or delete it.'), h('div', { class: 'rc-chips' }, ...unique.slice(0, 24).map((entry) => h('span', { class: 'rc-badge warn' }, `${entry.section} · ${entry.id}`))));
}
function openProfileEditor(user, refresh) {
    const form = renderForm(PROFILE_FIELDS, { ...user }, async (values) => {
        await api.updateUser(user.networkUid, values);
        toast('Profile saved');
        refresh();
    }, 'Save profile');
    openModal(`Edit ${user.firstName}`, form);
}
function mailItems(globalItemIdsJson) {
    let ids = [];
    try {
        ids = JSON.parse(globalItemIdsJson || '[]');
    }
    catch {
        ids = [];
    }
    return h('span', {}, ids.map((id) => itemLabel(id)).join(', ') || '—');
}
function parseMailValues(values) {
    return { ...values, globalItemIds: itemListTextToIds(String(values.globalItemIds || '')) };
}
function crudSection(options) {
    const { title, data, refresh, headers, renderRow, fields, valuesOf, keyOf, onAdd, onUpdate, onDelete, noEdit } = options;
    const openEditor = (existing) => {
        const values = existing ? valuesOf(existing) : {};
        const form = renderForm(fields, values, async (collected) => {
            if (existing) {
                await onUpdate?.(keyOf(existing), collected);
            }
            else {
                await onAdd(collected);
            }
            toast(existing ? 'Updated' : 'Added');
            await refresh();
        }, existing ? 'Save changes' : 'Add');
        openModal(existing ? `Edit ${title.toLowerCase()}` : `Add ${title.toLowerCase()}`, form);
    };
    const panel = h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, title, h('span', { class: 'rc-dim' }, ` ${fmt(data.length)}`)), h('button', { class: 'rc-btn small primary', type: 'button' }, '+ Add').also((btn) => btn.addEventListener('click', () => openEditor(null)))));
    panel.append(table(headers, data.map((item) => [
        ...renderRow(item),
        h('span', { class: 'rc-row-actions' }, noEdit ? null :
            also(h('button', { class: 'rc-btn small', type: 'button' }, 'Edit'), (btn) => btn.addEventListener('click', () => openEditor(item))), also(h('button', { class: 'rc-btn small danger', type: 'button' }, 'Delete'), (btn) => {
            btn.addEventListener('click', async () => {
                if (!(await confirmDialog('Delete?', `Remove this ${title.toLowerCase()} entry?`, true)))
                    return;
                await onDelete(keyOf(item));
                toast('Deleted');
                await refresh();
            });
        })),
    ])));
    return panel;
}
function imagesSection(user) {
    const panel = h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Stored images', h('span', { class: 'rc-dim' }, ` ${fmt(user.storedImages.length)}`))));
    if (user.storedImages.length === 0) {
        panel.append(h('p', { class: 'rc-empty' }, 'No stored images.'));
        return panel;
    }
    const grid = h('div', { class: 'rc-thumbs' });
    for (const image of user.storedImages) {
        const url = `/__api/profile-image/${encodeURIComponent(user.networkUid)}/${image.imageType}.png`;
        grid.append(h('figure', {}, h('img', { src: url, alt: `image type ${image.imageType}` }), h('figcaption', {}, `type ${image.imageType} · ${image.width}×${image.height} · ${isoTime(image.createdAt)}`)));
    }
    panel.append(grid);
    return panel;
}
function otherRecordsSection(user) {
    const groups = [
        ['Friend visits', user.visits],
        ['Visit credits', user.visitCredits],
        ['Rankings given', user.rankingsGiven],
        ['Rankings received', user.rankingsReceived],
        ['Notifications', [...user.notificationsSent, ...user.notificationsReceived]],
        ['Cash transactions', user.cashTransactions],
    ];
    const panel = h('section', { class: 'rc-panel' }, h('div', { class: 'rc-panel-head' }, h('h2', {}, 'Other records')));
    for (const [label, rows] of groups) {
        const details = h('details', { class: 'rc-json' }, h('summary', {}, `${label} — ${fmt(rows.length)}`), h('pre', {}, rows.length ? JSON.stringify(rows.slice(0, 50), null, 2) : 'none'));
        panel.append(details);
    }
    return panel;
}
// ---------- field specs ----------
const PROFILE_FIELDS = [
    { key: 'networkUid', label: 'Network UID', type: 'text', required: true, help: '1–18 digits; unique.' },
    { key: 'playfishUid', label: 'Playfish UID', type: 'number', min: 0 },
    { key: 'firstName', label: 'First name', type: 'text', required: true },
    { key: 'fullName', label: 'Full name', type: 'text', required: true },
    { key: 'restaurantName', label: 'Restaurant name', type: 'text' },
    { key: 'gender', label: 'Gender', type: 'select', options: [{ value: '0', label: '0 (unknown)' }, { value: '1', label: '1' }, { value: '2', label: '2' }] },
    { key: 'userLevel', label: 'Level', type: 'number', min: 1, max: 99 },
    { key: 'credits', label: 'Coins', type: 'number', min: 0 },
    { key: 'cashBalance', label: 'Cash', type: 'number', min: 0 },
    { key: 'gourmetPoint', label: 'Gourmet points', type: 'number', min: 0 },
    { key: 'playCount', label: 'Play count', type: 'number', min: 0 },
    { key: 'nbVote', label: 'Votes', type: 'number', min: 0 },
    { key: 'totalMark', label: 'Total mark', type: 'number', min: 0 },
    { key: 'trashPoint', label: 'Trash points', type: 'number', min: 0 },
    { key: 'demandPoint', label: 'Demand points', type: 'number', min: 0 },
    { key: 'musicPlay', label: 'Music play', type: 'number', min: 0 },
    { key: 'bookmarkCount', label: 'Bookmarks', type: 'number', min: 0 },
    { key: 'activeFloorIndex', label: 'Active floor', type: 'number', min: 0, max: 8 },
    { key: 'isInStreet', label: 'In street', type: 'bool' },
    { key: 'saveVersion', label: 'Save version', type: 'number', min: 0 },
    { key: 'lastSave', label: 'Last save (unix)', type: 'number', min: 0 },
    { key: 'lastSurveyTime', label: 'Last survey (unix)', type: 'number', min: 0 },
    { key: 'consecutionCount', label: 'Consecution count', type: 'number', min: 0 },
];
const OWNED_FIELDS = [
    itemField('globalItemId', 'Item', 'Required — choose from the catalogue.'),
    { key: 'positionX', label: 'X', type: 'number', min: -1000, max: 1000 },
    { key: 'positionY', label: 'Y', type: 'number', min: -1000, max: 1000 },
    { key: 'data', label: 'Data', type: 'number', min: 0, max: 255 },
    { key: 'roomIndex', label: 'Room', type: 'number', min: 0, max: 8 },
    { key: 'employeeNetwork', label: 'Employee network', type: 'number', min: 0, max: 99 },
    { key: 'employeeNetworkUid', label: 'Employee UID', type: 'text' },
    { key: 'employeePlayfishUid', label: 'Employee playfish UID', type: 'number', min: 0 },
];
const INVENTORY_FIELDS = [
    itemField('globalItemId', 'Recipe item'),
    { key: 'number', label: 'Count', type: 'number', min: 0 },
    { key: 'isSelected', label: 'Selected', type: 'bool' },
];
const INGREDIENT_FIELDS = [
    itemField('globalItemId', 'Ingredient'),
    { key: 'number', label: 'Count', type: 'number', min: 0 },
    { key: 'isLocked', label: 'Locked', type: 'bool' },
];
const GARDEN_FIELDS = [
    { key: 'plotId', label: 'Plot id', type: 'number', min: 0, max: 99 },
    itemField('ingredientId', 'Ingredient'),
    { key: 'plantWetTime', label: 'Plant wet time (unix)', type: 'number', min: 0 },
    { key: 'timeToDry', label: 'Time to dry (ms)', type: 'number', min: 0 },
];
const FLOOR_FIELDS = [
    { key: 'floorIndex', label: 'Floor index', type: 'number', min: 0, max: 8 },
    { key: 'tilesJson', label: 'Tiles JSON', type: 'textarea', help: 'JSON array of tile ids, e.g. [0,0,1,…]' },
];
const EMPLOYEE_FIELDS = [
    { key: 'networkUid', label: 'Employee (player)', type: 'player', required: true, placeholder: 'e.g. Mia Cafe', help: 'Employees are other players hired to work here.' },
    { key: 'network', label: 'Network', type: 'number', min: 0, max: 99 },
    { key: 'playfishUid', label: 'Playfish UID', type: 'number', min: 0 },
    { key: 'happiness', label: 'Happiness (ms)', type: 'number', min: 0, max: 14400000 },
    { key: 'task', label: 'Task', type: 'number', min: 0, max: 255 },
    { key: 'notify', label: 'Notify', type: 'bool' },
];
const MAIL_FIELDS = [
    { key: 'senderNetworkUid', label: 'Sender (player)', type: 'player', help: 'Defaults to the system player (0).' },
    { key: 'recipientNetworkUid', label: 'Recipient (player)', type: 'player' },
    { key: 'message', label: 'Message', type: 'textarea' },
    { key: 'globalItemIds', label: 'Attached items', type: 'text', help: 'Comma-separated item names or ids, e.g. Apple, Basic Window' },
    { key: 'itemId', label: 'Item id', type: 'number', min: 0 },
    { key: 'read', label: 'Read', type: 'bool' },
    { key: 'deleted', label: 'Deleted', type: 'bool' },
    { key: 'type', label: 'Type', type: 'number', min: 0, max: 255 },
];
const EVENT_FIELDS = [
    { key: 'eventType', label: 'Event type', type: 'number', min: 0, max: 255 },
    { key: 'eventText', label: 'Event text', type: 'textarea' },
    { key: 'createdAtUnix', label: 'Created at (unix)', type: 'number', min: 0 },
];
