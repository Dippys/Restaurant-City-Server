import { api } from '../api.js';
import { also, badge, confirmDialog, fmt, h, toast } from '../ui.js';
import type { AnomalyFinding, ModerationPlayerDetail, ModerationPlayerSummary } from '../types.js';

export async function render(container: HTMLElement, params: string[]): Promise<void> {
  const uid = params[0] ? decodeURIComponent(params[0]) : '';
  if (uid) return renderDetail(container, uid);
  return renderQueue(container);
}

async function renderQueue(container: HTMLElement): Promise<void> {
  container.textContent = 'Loading…';
  const data = await api.moderation();
  const active = data.players.filter((player) => player.openFindings > 0);
  const critical = active.filter((player) => player.highestSeverity === 'CRITICAL').length;
  const high = active.filter((player) => player.highestSeverity === 'HIGH').length;
  let filter = '';
  let severityFilter = 'ALL';
  const panel = h('section', { class: 'rc-panel' });
  const redraw = () => {
    const shown = active.filter((player) => (severityFilter === 'ALL' || player.highestSeverity === severityFilter) && (!filter || playerText(player).includes(filter)));
    panel.textContent = '';
    panel.append(h('table', { class: 'rc-table' },
      h('thead', {}, h('tr', {}, ...['Risk', 'Player', 'State', 'Progress', 'Measured activity', 'Findings', 'Last update', ''].map((label) => h('th', {}, label)))),
      h('tbody', {}, ...(shown.length ? shown.map((player) => h('tr', {},
        h('td', {}, badge(`${player.riskScore} · ${player.highestSeverity}`, severityClass(player.highestSeverity))),
        h('td', {}, h('b', {}, player.account?.username ?? player.networkUid), h('div', { class: 'rc-dim rc-mono' }, player.networkUid)),
        h('td', {}, player.account?.disabled ? badge('BANNED', 'err') : data.onlineNetworkUids.includes(player.networkUid) ? badge('ONLINE', 'ok') : badge('offline', 'muted')),
        h('td', {}, `Lv ${fmt(player.profile?.userLevel ?? 0)} · ${gourmetText(player.profile?.gourmetPoint ?? 0)}`, h('div', { class: 'rc-dim' }, `${fmt(player.profile?.credits ?? 0)} coins`)),
        h('td', {}, player.activity ? duration(player.activity.totalActiveSeconds) : 'not measured', h('div', { class: 'rc-dim' }, `${fmt(player.activity?.saveCount ?? 0)} saves`)),
        h('td', {}, `${player.openFindings} open`, h('div', { class: 'rc-dim' }, player.findings.filter((item) => activeStatus(item.status)).slice(0, 2).map((item) => item.title).join(' · '))),
        h('td', {}, dateText(player.profile?.updatedAt)),
        h('td', {}, also(h('button', { class: 'rc-btn small', type: 'button' }, 'Review'), (button) => button.addEventListener('click', () => { location.hash = `#/anomalies/${encodeURIComponent(player.networkUid)}`; }))),
      )) : [h('tr', {}, h('td', { colspan: '8', class: 'rc-empty' }, 'No active anomaly findings.'))])),
    ));
  };
  const scanButton = also(h('button', { class: 'rc-btn primary', type: 'button' }, 'Run full scan now'), (button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { const result = await api.runModerationScan(); toast(`Scan complete: ${fmt(result.result.findingsCreated ?? 0)} new, ${fmt(result.result.findingsUpdated ?? 0)} changed`); await renderQueue(container); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), false); button.disabled = false; }
  }));
  const resetButton = also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Reset all & re-scan'), (button) => button.addEventListener('click', async () => {
    if (!(await confirmDialog('Reset all findings?', 'Delete every anomaly finding and its review history, then immediately re-run the full scan so only fresh results remain.', true))) return;
    button.disabled = true;
    try {
      const result = await api.resetModerationFindings();
      toast(`Reset: ${fmt(result.result.reset ?? 0)} findings cleared; re-scan found ${fmt(result.result.findingsCreated ?? 0)} new, ${fmt(result.result.findingsUpdated ?? 0)} changed`);
      await renderQueue(container);
    } catch (error) { toast(error instanceof Error ? error.message : String(error), false); button.disabled = false; }
  }));
  const search = also(h('input', { class: 'rc-input', type: 'search', placeholder: 'search player, uid, rule…' }), (input) => input.addEventListener('input', () => { filter = input.value.trim().toLowerCase(); redraw(); }));
  const severity = also(h('select', { class: 'rc-input' }, ...['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((value) => h('option', { value }, value === 'ALL' ? 'All severities' : value))), (input) => input.addEventListener('change', () => { severityFilter = input.value; redraw(); }));
  container.textContent = '';
  container.append(h('h1', { class: 'rc-title' }, 'Anomaly review'), h('p', { class: 'rc-sub' }, 'Explainable evidence only. No finding automatically bans, deletes, or rolls back a player.'),
    h('div', { class: 'rc-cards' }, card('Flagged players', fmt(active.length), 'active findings'), card('Critical', fmt(critical), 'mathematical contradictions'), card('High', fmt(high), 'strong supporting signals'), card('Last scan', dateText(data.latestScan?.completedAt ?? data.latestScan?.startedAt), data.latestScan?.discordError ? 'Discord pending/error' : data.latestScan?.discordSent ? 'Discord sent' : 'no Discord delivery')),
    h('div', { class: 'rc-toolbar' }, search, severity, scanButton, resetButton), panel);
  redraw();
}

async function renderDetail(container: HTMLElement, uid: string): Promise<void> {
  container.textContent = 'Loading…';
  const { player } = await api.moderationPlayer(uid);
  let reason = '';
  const reasonBox = also(h('textarea', { class: 'rc-input', rows: '3', placeholder: 'Required moderation reason (3–500 characters)…' }), (input) => input.addEventListener('input', () => { reason = input.value; }));
  const act = async (label: string, detail: string, action: () => Promise<unknown>, danger = true) => {
    if (reason.trim().length < 3) { toast('Enter a moderation reason first.', false); return; }
    if (!(await confirmDialog(label, detail, danger))) return;
    try { await action(); toast(`${label} completed`); await renderDetail(container, uid); } catch (error) { toast(error instanceof Error ? error.message : String(error), false); }
  };
  const account = player.account;
  const controls = h('section', { class: 'rc-panel rc-danger' }, h('h2', {}, 'Moderation controls'), h('p', { class: 'rc-note' }, 'Rollback, reset, ban, and termination revoke active database sessions. A banned account cannot log in again until unbanned.'), reasonBox,
    h('div', { class: 'rc-toolbar' },
      also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Terminate live sessions'), (button) => button.addEventListener('click', () => void act('Terminate sessions', `Immediately revoke every session for ${uid}. Unsaved client work will be lost.`, () => api.terminatePlayer(uid, reason)))),
      account?.disabled
        ? also(h('button', { class: 'rc-btn', type: 'button' }, 'Unban account'), (button) => button.addEventListener('click', () => void act('Unban account', `Allow ${uid} to log in again.`, () => api.unbanPlayer(uid, reason), false)))
        : also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Ban account'), (button) => button.addEventListener('click', () => void act('Ban account', `Disable ${uid} and revoke every active session.`, () => api.banPlayer(uid, reason)))),
      also(h('button', { class: 'rc-btn danger', type: 'button' }, 'Reset to starter'), (button) => button.addEventListener('click', () => void act('Reset to starter', `Create a recovery snapshot, then restore ${uid} to level 1, zero gourmet/coins, and the shipped starter restaurant.`, () => api.resetPlayer(uid, reason)))),
      also(h('button', { class: 'rc-btn', type: 'button' }, 'Create snapshot'), (button) => button.addEventListener('click', async () => { try { await api.createModerationSnapshot(uid, reason || 'Manual snapshot'); toast('Snapshot created'); await renderDetail(container, uid); } catch (error) { toast(error instanceof Error ? error.message : String(error), false); } })),
    ));

  container.textContent = '';
  container.append(
    h('div', { class: 'rc-toolbar' }, also(h('button', { class: 'rc-btn small', type: 'button' }, '← Anomaly queue'), (button) => button.addEventListener('click', () => { location.hash = '#/anomalies'; }))),
    h('section', { class: 'rc-panel rc-profile' }, h('div', {}, h('h1', { class: 'rc-title' }, account?.username ?? uid), h('p', { class: 'rc-sub' }, `${uid} · ${player.profile?.restaurantName ?? 'No profile'}`), h('div', { class: 'rc-badges' }, badge(`Risk ${player.riskScore}`, severityClass(player.highestSeverity)), badge(player.highestSeverity, severityClass(player.highestSeverity)), badge(player.online ? 'ONLINE' : 'offline', player.online ? 'ok' : 'muted'), badge(account?.disabled ? 'BANNED' : 'enabled', account?.disabled ? 'err' : 'ok'), badge(`Lv ${player.profile?.userLevel ?? 0}`, 'muted'), badge(gourmetText(player.profile?.gourmetPoint ?? 0), 'muted'), badge(`${duration(player.activity?.totalActiveSeconds ?? 0)} measured`, 'muted')))),
    controls,
    findingsPanel(player, async () => renderDetail(container, uid)),
    snapshotsPanel(player, () => reason, async () => renderDetail(container, uid)),
    savesPanel(player),
    actionsPanel(player),
  );
}

function findingsPanel(player: ModerationPlayerDetail, refresh: () => Promise<void>): HTMLElement {
  const head = h('thead', {}, h('tr', {}, ...['Severity', 'Rule / evidence', 'Status', 'Occurrences', 'Review'].map((label) => h('th', {}, label))));
  const body = h('tbody', {}, ...player.findings.map((finding) => findingRow(finding, refresh)));
  return h('section', { class: 'rc-panel' }, h('h2', {}, `Findings (${player.findings.length})`), h('table', { class: 'rc-table' }, head, body));
}

function findingRow(finding: AnomalyFinding, refresh: () => Promise<void>): HTMLElement {
  let status = finding.status;
  let note = finding.reviewNote || '';
  const select = also(h('select', { class: 'rc-input' }, ...['OPEN', 'REVIEWED', 'DISMISSED', 'CONFIRMED'].map((value) => h('option', value === status ? { value, selected: true } : { value }, value))), (input) => input.addEventListener('change', () => { status = input.value; }));
  const noteInput = also(h('input', { class: 'rc-input', value: note, placeholder: 'review note…' }), (input) => input.addEventListener('input', () => { note = input.value; }));
  const save = also(h('button', { class: 'rc-btn small', type: 'button' }, 'Save'), (button) => button.addEventListener('click', async () => { try { await api.reviewFinding(finding.id, { status, note }); toast('Finding updated'); await refresh(); } catch (error) { toast(error instanceof Error ? error.message : String(error), false); } }));
  return h('tr', {}, h('td', {}, badge(`${finding.severity} · ${finding.score}`, severityClass(finding.severity))), h('td', {}, h('b', {}, finding.title), h('div', { class: 'rc-dim' }, finding.summary), h('details', { class: 'rc-json' }, h('summary', {}, `${finding.ruleId} · evidence`), h('pre', {}, prettyJson(finding.evidenceJson)))), h('td', {}, select), h('td', {}, fmt(finding.occurrenceCount), h('div', { class: 'rc-dim' }, dateText(finding.lastSeenAt))), h('td', {}, h('div', { class: 'rc-row-actions' }, noteInput, save)));
}

function snapshotsPanel(player: ModerationPlayerDetail, reason: () => string, refresh: () => Promise<void>): HTMLElement {
  const rows = player.snapshots.map((snapshot) => {
    const rollback = also(h('button', { class: 'rc-btn small danger', type: 'button' }, 'Rollback'), (button) => button.addEventListener('click', async () => {
      if (reason().trim().length < 3) { toast('Enter a moderation reason above first.', false); return; }
      if (!(await confirmDialog('Rollback player?', `Restore the complete gameplay state from ${dateText(snapshot.createdAt)} and terminate active sessions.`, true))) return;
      try { await api.rollbackPlayer(player.networkUid, snapshot.id, reason()); toast('Rollback completed'); await refresh(); }
      catch (error) { toast(error instanceof Error ? error.message : String(error), false); }
    }));
    return h('tr', {},
      h('td', {}, dateText(snapshot.createdAt)),
      h('td', {}, snapshot.reason, h('div', { class: 'rc-dim' }, snapshot.label)),
      h('td', {}, `Lv ${snapshot.userLevel} · ${gourmetText(snapshot.gourmetPoint)}`, h('div', { class: 'rc-dim' }, `${snapshot.placedItems} placed · ${snapshot.employeeCount} staff`)),
      h('td', {}, `${fmt(snapshot.credits)} coins · ${fmt(snapshot.cashBalance)} cash`, h('div', { class: 'rc-dim' }, `${fmt(snapshot.inventoryUnits)} inventory · ${fmt(snapshot.ingredientUnits)} ingredients`)),
      h('td', { class: 'rc-mono' }, snapshot.payloadDigest.slice(0, 12)), h('td', {}, rollback));
  });
  const bodyRows = rows.length ? rows : [h('tr', {}, h('td', { colspan: '6', class: 'rc-empty' }, 'No snapshots recorded yet.'))];
  return h('section', { class: 'rc-panel' }, h('h2', {}, `Rollback points (${player.snapshots.length})`), h('p', { class: 'rc-note' }, 'Each accepted save preserves the state immediately before it. Rollback first creates another recovery snapshot and terminates sessions.'), h('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, ...['When', 'Reason', 'Stage', 'Resources', 'Digest', ''].map((label) => h('th', {}, label)))), h('tbody', {}, ...bodyRows)));
}

function savesPanel(player: ModerationPlayerDetail): HTMLElement {
  const rows = player.saves.map((save) => h('tr', {},
    h('td', {}, dateText(save.createdAt)),
    h('td', {}, `v${save.saveVersion}`, h('div', { class: 'rc-dim' }, `client Δ ${save.clientDeltaSeconds}s · server Δ ${save.serverDeltaSeconds}s`)),
    h('td', {}, fmt(save.credits), h('div', { class: 'rc-dim' }, signed(save.creditDelta))),
    h('td', {}, gourmetText(save.gourmetPoint), h('div', { class: 'rc-dim' }, `${signed(Math.trunc(save.gourmetDelta / 10))} displayed · ${signed(save.gourmetDelta)} stored`)),
    h('td', {}, `${save.previousLevel} → ${save.userLevel}`),
    h('td', {}, `${fmt(save.actionCount)} actions`, h('div', { class: save.unknownActionCount ? 'rc-err' : 'rc-dim' }, `${fmt(save.unknownActionCount)} unknown`), h('details', { class: 'rc-json' }, h('summary', {}, 'action counts'), h('pre', {}, prettyJson(save.actionCountsJson)))),
    h('td', {}, `${fmt(save.placedItems)} placed · ${fmt(save.employeeCount)} staff`, h('div', { class: 'rc-dim' }, `${fmt(save.inventoryUnits)} inventory · ${fmt(save.ingredientUnits)} ingredients · ${fmt(save.gardenPlotCount)} plots`))));
  const bodyRows = rows.length ? rows : [h('tr', {}, h('td', { colspan: '7', class: 'rc-empty' }, 'No accepted-save facts recorded yet.'))];
  return h('section', { class: 'rc-panel' }, h('h2', {}, `Accepted save history (${player.saves.length} shown)`), h('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, ...['When', 'Version / clocks', 'Coins', 'Gourmet', 'Level', 'Audit', 'Restaurant state'].map((label) => h('th', {}, label)))), h('tbody', {}, ...bodyRows)));
}

function actionsPanel(player: ModerationPlayerDetail): HTMLElement {
  const rows = player.actions.map((action) => h('tr', {}, h('td', {}, dateText(action.createdAt)), h('td', {}, action.actorUsername), h('td', {}, badge(action.actionType, action.actionType === 'BAN' || action.actionType.includes('RESET') ? 'err' : 'muted')), h('td', {}, action.reason), h('td', {}, h('details', { class: 'rc-json' }, h('summary', {}, action.snapshotId ? `snapshot ${action.snapshotId.slice(0, 8)}` : 'details'), h('pre', {}, prettyJson(action.detailsJson))))));
  const bodyRows = rows.length ? rows : [h('tr', {}, h('td', { colspan: '5', class: 'rc-empty' }, 'No moderation actions.'))];
  return h('section', { class: 'rc-panel' }, h('h2', {}, 'Moderation audit trail'), h('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, ...['When', 'Actor', 'Action', 'Reason', 'Details'].map((label) => h('th', {}, label)))), h('tbody', {}, ...bodyRows)));
}

function card(label: string, value: string, sub: string): HTMLElement { return h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-label' }, label), h('div', { class: 'rc-card-value' }, value), h('div', { class: 'rc-card-sub' }, sub)); }
function severityClass(value: string): 'err' | 'warn' | 'ok' | 'muted' { return value === 'CRITICAL' ? 'err' : value === 'HIGH' || value === 'MEDIUM' ? 'warn' : value === 'LOW' ? 'muted' : 'ok'; }
function activeStatus(value: string): boolean { return value === 'OPEN' || value === 'REVIEWED' || value === 'CONFIRMED'; }
function playerText(player: ModerationPlayerSummary): string { return `${player.networkUid} ${player.account?.username ?? ''} ${player.profile?.restaurantName ?? ''} ${player.findings.map((item) => `${item.ruleId} ${item.title}`).join(' ')}`.toLowerCase(); }
function duration(seconds: number): string { const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); return `${hours}h ${minutes}m`; }
function dateText(value?: string | null): string { return value ? new Date(value).toLocaleString('en-GB') : 'never'; }
function prettyJson(value: string): string { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
function signed(value: number): string { return `${value >= 0 ? '+' : ''}${fmt(value)}`; }
function gourmetText(stored: number): string { return `${fmt(Math.floor(stored / 10))} GP (${fmt(stored)} stored)`; }
