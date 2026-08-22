// Admin dashboard shell: sidebar, hash routing, session.
import { api, setCsrfToken } from './api.js';
import { also, h } from './ui.js';
import * as overview from './views/overview.js';
import * as traffic from './views/traffic.js';
import * as users from './views/users.js';
import * as economy from './views/economy.js';
import * as game from './views/game.js';
import * as assets from './views/assets.js';
const NAV = [
    { id: 'overview', label: 'Overview' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'users', label: 'Players' },
    { id: 'economy', label: 'Economy' },
    { id: 'game', label: 'Game tools' },
    { id: 'assets', label: 'Assets' },
];
const VIEWS = { overview, traffic, users, economy, game, assets };
function navId() {
    const id = (location.hash.match(/^#\/([a-z-]+)/) ?? [])[1] ?? 'overview';
    return VIEWS[id] ? id : 'overview';
}
function params() {
    const rest = location.hash.replace(/^#\/[a-z-]+/, '').replace(/^\//, '');
    return rest ? rest.split('/').filter(Boolean) : [];
}
let activeNav = null;
function setActiveNav(id) {
    document.querySelectorAll('#rc-nav a').forEach((link) => {
        link.classList.toggle('active', link.dataset.view === id);
    });
}
async function route() {
    const id = navId();
    setActiveNav(id);
    const view = document.getElementById('rc-view');
    if (!view)
        return;
    view.scrollTop = 0;
    try {
        await VIEWS[id].render(view, params());
    }
    catch (error) {
        view.textContent = '';
        view.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
    }
}
async function boot() {
    const side = document.getElementById('rc-side');
    if (!side)
        return;
    let account = null;
    try {
        const session = await api.session();
        if (!session.loggedIn || !session.account) {
            location.href = '/login?next=/admin';
            return;
        }
        account = session.account;
        setCsrfToken(session.csrfToken || '');
    }
    catch {
        location.href = '/login?next=/admin';
        return;
    }
    side.append(h('div', { class: 'rc-brand' }, h('span', { class: 'rc-plate' }), h('span', {}, 'RC Reborn Admin')), h('nav', { id: 'rc-nav' }, ...NAV.map((item) => h('a', { href: `#/${item.id}`, 'data-view': item.id }, item.label))), h('div', { class: 'rc-side-foot' }, h('span', { class: 'rc-dim' }, `Signed in as ${account.username}`), h('a', { class: 'rc-btn small', href: 'https://discord.gg/Ppuwb826eC', target: '_blank', rel: 'noopener' }, 'Discord ↗'), also(h('button', { class: 'rc-btn small', type: 'button' }, 'Log out'), (btn) => {
        btn.addEventListener('click', async () => {
            try {
                await api.logout();
            }
            catch {
                // ignore
            }
            location.href = '/login';
        });
    })));
    window.addEventListener('hashchange', () => void route());
    await route();
}
boot().catch((error) => {
    const view = document.getElementById('rc-view');
    if (view)
        view.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
});
