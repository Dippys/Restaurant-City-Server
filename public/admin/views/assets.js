// Assets: what the server currently serves.
import { api } from '../api.js';
import { also, badge, el, fmt, fmtBytes, h, toast } from '../ui.js';
export async function render(container) {
    container.textContent = 'Loading…';
    let data;
    try {
        data = await api.assets();
    }
    catch (error) {
        container.textContent = '';
        container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
        return;
    }
    const total = data.files.reduce((sum, file) => sum + file.size, 0);
    const toolbar = h('div', { class: 'rc-toolbar' }, h('span', { class: 'rc-stat' }, `${fmt(data.files.length)} files · ${fmtBytes(total)}`), data.servesRebuiltGameSwf ? badge('rebuilt game.swf active', 'ok') : badge('original game.swf', 'warn'), also(h('button', { class: 'rc-btn', type: 'button' }, 'Reindex'), (btn) => {
        btn.addEventListener('click', async () => {
            try {
                const result = await api.reindex();
                toast(`Reindexed: ${result.files} files`);
                render(container);
            }
            catch (error) {
                toast(error instanceof Error ? error.message : String(error), false);
            }
        });
    }));
    const tableEl = el('table', { class: 'rc-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Served name'), h('th', {}, 'File'), h('th', {}, 'Size'))));
    const body = h('tbody');
    for (const file of data.files) {
        body.append(h('tr', {}, h('td', {}, h('b', {}, file.name)), h('td', { class: 'rc-mono' }, file.path), h('td', {}, fmtBytes(file.size))));
    }
    tableEl.append(body);
    container.textContent = '';
    container.append(h('h1', { class: 'rc-title' }, 'Served assets'), h('p', { class: 'rc-sub' }, 'Everything the game can load — SWFs and data files — resolved by basename from server/public/.'), toolbar, h('section', { class: 'rc-panel' }, tableEl));
}
