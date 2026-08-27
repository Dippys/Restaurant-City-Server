import { api, type SocialLinkAdmin } from '../api.js';
import { also, badge, h, openModal, renderForm, table, toast } from '../ui.js';

export async function render(container: HTMLElement): Promise<void> {
  container.textContent = 'Loading…';
  const links = (await api.socialLinks()).links;
  const create = also(h('button', { class: 'rc-btn primary', type: 'button' }, 'Create campaign'), (button) => button.addEventListener('click', () => openCreate(container)));
  container.textContent = '';
  container.append(
    h('div', { class: 'rc-panel-head' }, h('div', {}, h('h1', { class: 'rc-title' }, 'Social links'), h('p', { class: 'rc-sub' }, 'Create, preview, schedule, limit, pause, revoke, duplicate and audit campaigns.')), create),
    table(['Campaign', 'Kind', 'Status', 'Claims', 'Schedule', 'Actions'], links.map((link) => [
      h('div', {}, h('b', {}, link.title), h('div', { class: 'rc-dim' }, `/s/${link.slug}`)), link.kind,
      badge(link.status, link.status === 'ACTIVE' ? 'ok' : link.status === 'REVOKED' ? 'err' : 'warn'),
      `${link.successfulActionCount}${link.totalActionLimit ? ` / ${link.totalActionLimit}` : ''}`,
      `${link.notBefore ? new Date(link.notBefore).toLocaleString() : 'Now'} → ${link.expiresAt ? new Date(link.expiresAt).toLocaleString() : 'No expiry'}`,
      actionBar(link, container),
    ]), 'No social-link campaigns yet.'),
  );
}

function actionBar(link: SocialLinkAdmin, container: HTMLElement): HTMLElement {
  const bar = h('div', { class: 'rc-toolbar' });
  const add = (label: string, fn: () => void) => bar.append(also(h('button', { class: 'rc-btn small', type: 'button' }, label), (button) => button.addEventListener('click', fn)));
  add('Preview', () => window.open(`/s/${link.slug}`, '_blank', 'noopener'));
  add('Copy', () => void navigator.clipboard.writeText(`${location.origin}/s/${link.slug}`).then(() => toast('Link copied')));
  add('Audit', () => void openAudit(link.id));
  if (link.status === 'DRAFT') add('Activate', () => void lifecycle(link.id, 'activate', container));
  if (link.status === 'ACTIVE') { add('Pause', () => void lifecycle(link.id, 'pause', container)); add('Expire', () => void lifecycle(link.id, 'expire', container)); }
  if (link.status === 'PAUSED') add('Resume', () => void lifecycle(link.id, 'resume', container));
  if (link.status !== 'REVOKED') add('Revoke', () => void lifecycle(link.id, 'revoke', container));
  add('Duplicate', () => void lifecycle(link.id, 'duplicate', container));
  return bar;
}

async function lifecycle(id: string, operation: 'activate' | 'pause' | 'resume' | 'revoke' | 'expire' | 'duplicate', container: HTMLElement): Promise<void> {
  try { await api.socialLifecycle(id, operation); toast(`Campaign ${operation}d`); await render(container); }
  catch (error) { toast(error instanceof Error ? error.message : String(error), false); }
}

function openCreate(container: HTMLElement): void {
  const form = renderForm([
    { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'promotion', label: 'Promotion' }, { value: 'specialDay', label: 'Special day' }, { value: 'announcement', label: 'Announcement' }, { value: 'leaderboard', label: 'Leaderboard' }, { value: 'referral', label: 'Referral' }], default: 'promotion' },
    { key: 'title', label: 'Title', type: 'text', required: true }, { key: 'description', label: 'Description', type: 'textarea', required: true },
    { key: 'imagePath', label: 'Approved image', type: 'select', options: ['/assets/chef.png','/assets/building.png','/assets/food-pizza.png','/assets/food-butter.png'].map((value) => ({ value, label: value })), default: '/assets/chef.png' },
    { key: 'rewardCategory', label: 'Reward category', type: 'select', options: ['inventory','ingredient','recipe','coins','gourmetPoints','playfishCash'].map((value) => ({ value, label: value })), default: 'inventory' },
    { key: 'itemId', label: 'Reward item', type: 'item', help: 'Ignored for currency and announcement campaigns.' }, { key: 'amount', label: 'Amount', type: 'number', min: 1, default: 1 },
    { key: 'notBefore', label: 'Starts (ISO date/time)', type: 'text' }, { key: 'expiresAt', label: 'Expires (ISO date/time)', type: 'text' },
    { key: 'totalActionLimit', label: 'Total limit', type: 'number', min: 1, default: 1 }, { key: 'perAccountLimit', label: 'Per-account limit', type: 'number', min: 1, default: 1 },
    { key: 'minLevel', label: 'Minimum player level', type: 'number', min: 1 }, { key: 'maxLevel', label: 'Maximum player level', type: 'number', min: 1 },
    { key: 'minAccountAgeDays', label: 'Minimum account age (days)', type: 'number', min: 1 },
    { key: 'allowlistUsernames', label: 'Username allowlist', type: 'text', help: 'Optional comma-separated usernames. Matching is case-insensitive.' },
    { key: 'requireOwnedItemId', label: 'Must own item', type: 'item' }, { key: 'excludeOwnedItemId', label: 'Must not own item', type: 'item' },
  ], {}, async (values) => {
    const reward = { category: values.rewardCategory, itemId: values.itemId, amount: values.amount };
    const eligibility = {
      minLevel: values.minLevel || undefined, maxLevel: values.maxLevel || undefined, minAccountAgeDays: values.minAccountAgeDays || undefined,
      allowlistUsernames: String(values.allowlistUsernames || '').split(',').map((value) => value.trim()).filter(Boolean),
      requireOwnedItemId: values.requireOwnedItemId || undefined, excludeOwnedItemId: values.excludeOwnedItemId || undefined,
    };
    await api.createSocialLink({ kind: values.kind, title: values.title, description: values.description, imagePath: values.imagePath, reward, eligibility, notBefore: values.notBefore || null, expiresAt: values.expiresAt || null, totalActionLimit: values.totalActionLimit, perAccountLimit: values.perAccountLimit });
    toast('Draft campaign created'); await render(container);
  }, 'Create draft');
  openModal('Create social-link campaign', form);
}

async function openAudit(id: string): Promise<void> {
  const link = (await api.socialLink(id)).link;
  const download = h('a', { class: 'rc-btn small', href: `/__api/admin/social-links/${id}/actions?format=csv`, download: true }, 'Export CSV');
  const body = h('div', {}, download, table(['When', 'Action', 'Outcome', 'Result'], (link.actions ?? []).map((row) => [new Date(row.createdAt).toLocaleString(), row.action, row.outcome, row.resultSummary]), 'No action attempts yet.'));
  openModal(`Audit — ${link.title}`, body);
}
