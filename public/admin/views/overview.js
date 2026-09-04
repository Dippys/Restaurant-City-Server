// Overview: server health, online users, quick actions.
import { api } from '../api.js';
import { also, confirmDialog, el, fmt, fmtBytes, fmtDuration, h, relTime, toast } from '../ui.js';
export async function render(container) {
    container.textContent = 'Loading…';
    let data;
    try {
        data = await api.overview();
    }
    catch (error) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
        return;
    }
    const card = (label, value, sub = '') => h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-label' }, label), h('div', { class: 'rc-card-value' }, value), sub ? h('div', { class: 'rc-card-sub' }, sub) : null);
    const cards = h('div', { class: 'rc-cards' });
    cards.append(card('Static files', fmt(data.staticFiles), data.servesRebuiltGameSwf ? 'rebuilt game.swf active' : 'original game.swf'), card('Request buffer', `${fmt(data.requestBuffer)} / ${fmt(data.maxLogEntries)}`, `${fmt(data.rpcCount)} RPC · ${fmt(data.notFoundCount)} 404`), card('Online players', fmt(data.onlineUsers.length), 'live sessions'), card('Uptime', fmtDuration(data.uptimeSeconds), `DB ${fmtBytes(data.dbSizeBytes)}`), card('Process memory', fmtBytes(data.performance.memory.rssBytes), `${fmtBytes(data.performance.memory.heapUsedBytes)} heap used`), card('Event-loop p99', `${data.performance.eventLoopDelayMs.p99.toFixed(1)} ms`, `max ${data.performance.eventLoopDelayMs.max.toFixed(1)} ms`), card('Requests', fmt(data.performance.requestCount), `p95 ${data.performance.requestLatency.p95Ms.toFixed(1)} ms · ${fmt(data.performance.activeRequests)} active`), card('Activity queue', fmt(data.performance.activityQueueSize), `${fmt(data.performance.rpcCount)} RPC measured`));
    const actions = h('div', { class: 'rc-toolbar' }, also(h('button', { class: 'rc-btn', type: 'button' }, 'Reindex assets'), (btn) => {
        btn.addEventListener('click', async () => {
            try {
                const result = await api.reindex();
                toast(`Reindexed: ${result.files} files indexed`);
                render(container);
            }
            catch (error) {
                toast(error instanceof Error ? error.message : String(error), false);
            }
        });
    }), also(h('button', { class: 'rc-btn', type: 'button' }, 'Clear request buffer'), (btn) => {
        btn.addEventListener('click', async () => {
            if (!(await confirmDialog('Clear the request buffer?', 'This only clears the in-memory request log shown on the Traffic page.', false)))
                return;
            await api.clearRequests();
            toast('Buffer cleared');
            render(container);
        });
    }));
    const onlineRows = data.onlineUsers.map((user) => [
        h('b', {}, user.username),
        user.networkUid,
        fmt(user.playfishUid),
        relTime(user.lastSeenUnix),
        `${user.pendingEvents} queued · ${user.inflightEvents} inflight`,
    ]);
    const online = h('section', { class: 'rc-panel' }, h('h2', {}, 'Online players'), el('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Username'), h('th', {}, 'Network UID'), h('th', {}, 'Playfish UID'), h('th', {}, 'Last seen'), h('th', {}, 'Events'))), h('tbody', {}, ...(onlineRows.length ? onlineRows.map((row) => h('tr', {}, ...row.map((cell) => h('td', {}, cell)))) : [h('tr', {}, h('td', { colspan: '5', class: 'rc-empty' }, 'No players online right now.'))]))));
    const jobs = Object.entries(data.performance.jobs);
    const jobPanel = h('section', { class: 'rc-panel' }, h('h2', {}, 'Background jobs'), el('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Job'), h('th', {}, 'State'), h('th', {}, 'Last duration'), h('th', {}, 'Skipped'), h('th', {}, 'Last error'))), h('tbody', {}, ...(jobs.length ? jobs.map(([name, job]) => h('tr', {}, h('td', {}, name), h('td', {}, job.running ? 'running' : 'idle'), h('td', {}, job.lastDurationMs == null ? '—' : `${fmt(job.lastDurationMs)} ms`), h('td', {}, fmt(job.skippedOverlaps)), h('td', {}, job.lastError || '—'))) : [h('tr', {}, h('td', { colspan: '5', class: 'rc-empty' }, 'No background job has run yet.'))]))));
    container.textContent = '';
    container.append(h('h1', { class: 'rc-title' }, 'Server overview'), h('p', { class: 'rc-sub' }, `Server time: ${new Date(data.serverTime).toLocaleString('en-GB')}`), cards, actions, online, jobPanel);
}
