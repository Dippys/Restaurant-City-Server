export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
let csrfToken = '';
export function setCsrfToken(token) {
    csrfToken = token;
}
async function request(method, path, body) {
    const headers = {};
    let payload;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    if (method !== 'GET') {
        headers['X-CSRF-Token'] = csrfToken;
    }
    let res;
    try {
        res = await fetch(path, { method, headers, body: payload });
    }
    catch (error) {
        throw new ApiError(0, error instanceof Error ? error.message : String(error));
    }
    let data;
    try {
        data = await res.json();
    }
    catch {
        throw new ApiError(res.status, `Invalid JSON response (HTTP ${res.status})`);
    }
    const record = data;
    if (!res.ok || record.ok === false) {
        throw new ApiError(res.status, record.error || `Request failed (HTTP ${res.status})`);
    }
    return data;
}
function enc(value) {
    return encodeURIComponent(String(value));
}
export const api = {
    // session / auth
    session: () => request('GET', '/__api/session'),
    logout: () => request('POST', '/__api/logout'),
    impersonateUser: (uid) => request('POST', '/__api/admin/impersonation', { networkUid: uid }),
    // server overview
    overview: () => request('GET', '/__api/admin/overview'),
    assets: () => request('GET', '/__api/admin/assets'),
    // traffic
    requests: () => request('GET', '/__api/requests'),
    clearRequests: () => request('POST', '/__api/clear'),
    reindex: () => request('POST', '/__api/reindex'),
    requestReset: () => request('POST', '/__api/db/reset'),
    // catalog + users
    catalog: () => request('GET', '/__api/db/catalog'),
    users: () => request('GET', '/__api/db/users'),
    createUser: (input) => request('POST', '/__api/db/users', input),
    updateUser: (uid, input) => request('PATCH', `/__api/db/users/${enc(uid)}`, input),
    deleteUser: (uid) => request('DELETE', `/__api/db/users/${enc(uid)}`),
    // user sub-resources (all return the refreshed user)
    addOwnedItem: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/items`, input),
    updateOwnedItem: (uid, serverId, input) => request('PATCH', `/__api/db/users/${enc(uid)}/items/${enc(serverId)}`, input),
    deleteOwnedItem: (uid, serverId) => request('DELETE', `/__api/db/users/${enc(uid)}/items/${enc(serverId)}`),
    addInventory: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/inventory`, input),
    updateInventory: (uid, id, input) => request('PATCH', `/__api/db/users/${enc(uid)}/inventory/${enc(id)}`, input),
    deleteInventory: (uid, id) => request('DELETE', `/__api/db/users/${enc(uid)}/inventory/${enc(id)}`),
    addIngredient: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/ingredients`, input),
    updateIngredient: (uid, id, input) => request('PATCH', `/__api/db/users/${enc(uid)}/ingredients/${enc(id)}`, input),
    deleteIngredient: (uid, id) => request('DELETE', `/__api/db/users/${enc(uid)}/ingredients/${enc(id)}`),
    addGardenPlot: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/garden`, input),
    updateGardenPlot: (uid, id, input) => request('PATCH', `/__api/db/users/${enc(uid)}/garden/${enc(id)}`, input),
    deleteGardenPlot: (uid, id) => request('DELETE', `/__api/db/users/${enc(uid)}/garden/${enc(id)}`),
    addFloor: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/floors`, input),
    updateFloor: (uid, id, input) => request('PATCH', `/__api/db/users/${enc(uid)}/floors/${enc(id)}`, input),
    deleteFloor: (uid, id) => request('DELETE', `/__api/db/users/${enc(uid)}/floors/${enc(id)}`),
    addEmployee: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/employees`, input),
    updateEmployee: (uid, employeeUid, input) => request('PATCH', `/__api/db/users/${enc(uid)}/employees/${enc(employeeUid)}`, input),
    deleteEmployee: (uid, employeeUid) => request('DELETE', `/__api/db/users/${enc(uid)}/employees/${enc(employeeUid)}`),
    addMail: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/mails`, input),
    updateMail: (uid, mailId, input) => request('PATCH', `/__api/db/users/${enc(uid)}/mails/${enc(mailId)}`, input),
    deleteMail: (uid, mailId) => request('DELETE', `/__api/db/users/${enc(uid)}/mails/${enc(mailId)}`),
    addGameEvent: (uid, input) => request('POST', `/__api/db/users/${enc(uid)}/events`, input),
    deleteGameEvent: (uid, eventId) => request('DELETE', `/__api/db/users/${enc(uid)}/events/${enc(eventId)}`),
    // economy
    economy: () => request('GET', '/__api/db/economy'),
    upsertPricepoint: (id, input) => request(id === null ? 'POST' : 'PATCH', `/__api/db/economy/pricepoints${id === null ? '' : `/${id}`}`, input),
    deletePricepoint: (id) => request('DELETE', `/__api/db/economy/pricepoints/${id}`),
    upsertPurchasableItem: (id, input) => request(id === null ? 'POST' : 'PATCH', `/__api/db/economy/purchasable-items${id === null ? '' : `/${id}`}`, input),
    deletePurchasableItem: (id) => request('DELETE', `/__api/db/economy/purchasable-items/${id}`),
    upsertIngredientMarketItem: (id, input) => request(id === null ? 'POST' : 'PATCH', `/__api/db/economy/ingredient-market${id === null ? '' : `/${id}`}`, input),
    deleteIngredientMarketItem: (id) => request('DELETE', `/__api/db/economy/ingredient-market/${id}`),
    // live
    online: () => request('GET', '/__api/live/online'),
    alert: (input) => request('POST', '/__api/live/alert', input),
    sendMail: (input) => request('POST', '/__api/live/mail', input),
    forceDailyIngredientSync: () => request('POST', '/__api/live/daily-ingredients/sync'),
    // moderation
    moderation: () => request('GET', '/__api/moderation'),
    moderationPlayer: (uid) => request('GET', `/__api/moderation/players/${enc(uid)}`),
    runModerationScan: () => request('POST', '/__api/moderation/scan'),
    resetModerationFindings: () => request('POST', '/__api/moderation/reset'),
    reviewFinding: (id, input) => request('PATCH', `/__api/moderation/findings/${enc(id)}`, input),
    createModerationSnapshot: (uid, label) => request('POST', `/__api/moderation/players/${enc(uid)}/snapshots`, { label }),
    rollbackPlayer: (uid, snapshotId, reason) => request('POST', `/__api/moderation/players/${enc(uid)}/rollback`, { snapshotId, reason }),
    resetPlayer: (uid, reason) => request('POST', `/__api/moderation/players/${enc(uid)}/reset`, { reason }),
    banPlayer: (uid, reason) => request('POST', `/__api/moderation/players/${enc(uid)}/ban`, { reason }),
    unbanPlayer: (uid, reason) => request('POST', `/__api/moderation/players/${enc(uid)}/unban`, { reason }),
    terminatePlayer: (uid, reason) => request('POST', `/__api/moderation/players/${enc(uid)}/terminate`, { reason }),
    fixFallbackPlayer: (uid) => request('POST', `/__api/moderation/players/${enc(uid)}/fix-fallback`, {}),
    socialLinks: () => request('GET', '/__api/admin/social-links'),
    socialLink: (id) => request('GET', `/__api/admin/social-links/${enc(id)}`),
    createSocialLink: (input) => request('POST', '/__api/admin/social-links', input),
    patchSocialLink: (id, input) => request('PATCH', `/__api/admin/social-links/${enc(id)}`, input),
    socialLifecycle: (id, operation) => request('POST', `/__api/admin/social-links/${enc(id)}/${operation}`),
};
