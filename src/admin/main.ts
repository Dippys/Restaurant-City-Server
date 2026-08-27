// Admin dashboard shell: sidebar, hash routing, session.
import { api, setCsrfToken } from './api.js';
import { also, h } from './ui.js';
import type { SessionAccount } from './types.js';
import * as overview from './views/overview.js';
import * as traffic from './views/traffic.js';
import * as users from './views/users.js';
import * as economy from './views/economy.js';
import * as game from './views/game.js';
import * as assets from './views/assets.js';
import * as socialLinks from './views/social-links.js';

const NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'users', label: 'Players' },
  { id: 'economy', label: 'Economy' },
  { id: 'game', label: 'Game tools' },
  { id: 'social-links', label: 'Social links' },
  { id: 'assets', label: 'Assets' },
];

interface ViewModule {
  render(container: HTMLElement, params: string[]): Promise<void>;
}

const VIEWS: Record<string, ViewModule> = { overview, traffic, users, economy, game, 'social-links': socialLinks, assets };

function navId(): string {
  const id = (location.hash.match(/^#\/([a-z-]+)/) ?? [])[1] ?? 'overview';
  return VIEWS[id] ? id : 'overview';
}

function params(): string[] {
  const rest = location.hash.replace(/^#\/[a-z-]+/, '').replace(/^\//, '');
  return rest ? rest.split('/').filter(Boolean) : [];
}

let activeNav: HTMLAnchorElement | null = null;

function setActiveNav(id: string): void {
  document.querySelectorAll<HTMLAnchorElement>('#rc-nav a').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === id);
  });
}

async function route(): Promise<void> {
  const id = navId();
  setActiveNav(id);
  const view = document.getElementById('rc-view');
  if (!view) return;
  view.scrollTop = 0;
  try {
    await VIEWS[id].render(view, params());
  } catch (error) {
    view.textContent = '';
    view.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
  }
}

async function boot(): Promise<void> {
  const side = document.getElementById('rc-side');
  if (!side) return;

  let account: SessionAccount | null = null;
  try {
    const session = await api.session();
    if (!session.loggedIn || !session.account) {
      location.href = '/login?next=/admin';
      return;
    }
    account = session.account;
    setCsrfToken(session.csrfToken || '');
  } catch {
    location.href = '/login?next=/admin';
    return;
  }

  side.append(
    h('div', { class: 'rc-brand' }, h('span', { class: 'rc-plate' }), h('span', {}, 'RC Reborn Admin')),
    h('nav', { id: 'rc-nav' }, ...NAV.map((item) =>
      h('a', { href: `#/${item.id}`, 'data-view': item.id }, item.label),
    )),
    h('div', { class: 'rc-side-foot' },
      h('span', { class: 'rc-dim' }, `Signed in as ${account.username}`),
      h('a', { class: 'rc-btn small', href: 'https://discord.gg/Ppuwb826eC', target: '_blank', rel: 'noopener' }, 'Discord ↗'),
      also(h('button', { class: 'rc-btn small', type: 'button' }, 'Log out'), (btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api.logout();
          } catch {
            // ignore
          }
          location.href = '/login';
        });
      }),
    ),
  );

  window.addEventListener('hashchange', () => void route());
  await route();
}

boot().catch((error) => {
  const view = document.getElementById('rc-view');
  if (view) view.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
});
