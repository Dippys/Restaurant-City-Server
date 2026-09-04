// Traffic: live request log over SSE, paginated (50/page) with filtering.
import { api } from '../api.js';
import { also, confirmDialog, esc, fmt, h, toast } from '../ui.js';
import type { CapturedRequest } from '../types.js';

const PAGE_SIZE = 50;
const MAX_BUFFER = 1000;

let entries: CapturedRequest[] = [];
let expanded = new Set<number>();
let filterValue = '';
let page = 0;
let live = true;
let source: EventSource | null = null;

export async function render(container: HTMLElement): Promise<void> {
  // Drop any previous live stream (section was re-entered).
  source?.close();
  source = null;

  container.textContent = 'Loading…';
  let initial: CapturedRequest[];
  try {
    initial = await api.requests();
  } catch (error) {
    container.textContent = '';
    container.append(h('p', { class: 'rc-err' }, error instanceof Error ? error.message : String(error)));
    return;
  }
  entries = [...initial];
  expanded = new Set<number>();
  filterValue = '';
  page = 0;
  live = true;

  const list = h('div', { id: 'traffic-list', class: 'rc-request-list' });

  const filterInput = h('input', { class: 'rc-input', type: 'search', placeholder: 'filter path / method / rpc…' });
  const liveBox = h('input', { type: 'checkbox' });
  liveBox.checked = true;
  const countLabel = h('span', { class: 'rc-stat', id: 'traffic-count' });
  const pageLabel = h('span', { class: 'rc-stat', id: 'traffic-page' });
  const prevBtn = h('button', { class: 'rc-btn small', type: 'button', id: 'traffic-prev' }, '← Older');
  const nextBtn = h('button', { class: 'rc-btn small', type: 'button', id: 'traffic-next' }, 'Newer →');
  const newestBtn = h('button', { class: 'rc-btn small primary', type: 'button', id: 'traffic-newest' }, '⬆ Newest');

  const toolbar = h('div', { class: 'rc-toolbar' },
    filterInput,
    h('label', { class: 'rc-check' }, liveBox, ' live (stick to newest)'),
  );
  const footer = h('div', { class: 'rc-traffic-foot' },
    countLabel,
    pageLabel,
    prevBtn,
    nextBtn,
    newestBtn,
    also(h('button', { class: 'rc-btn small', type: 'button' }, 'Copy all'), (btn) => {
      btn.addEventListener('click', async () => {
        const filtered = applyFilter(entries);
        const text = filtered.map(copyText).join('\n\n' + '='.repeat(60) + '\n\n');
        try {
          await navigator.clipboard.writeText(text);
          toast(`Copied ${fmt(filtered.length)} entries`);
        } catch {
          toast('Clipboard unavailable', false);
        }
      });
    }),
    also(h('button', { class: 'rc-btn small', type: 'button' }, 'Clear'), (btn) => {
      btn.addEventListener('click', async () => {
        if (!(await confirmDialog('Clear the request buffer?', 'The live log will empty; new requests keep arriving.', false))) return;
        await api.clearRequests();
        entries = [];
        expanded.clear();
        page = 0;
        renderList();
      });
    }),
  );

  filterInput.addEventListener('input', () => {
    filterValue = filterInput.value.trim().toLowerCase();
    page = 0;
    renderList();
  });
  liveBox.addEventListener('change', () => {
    live = liveBox.checked;
    if (live) {
      page = 0;
      renderList();
    }
  });
  prevBtn.addEventListener('click', () => {
    if (page < totalPages()) {
      page += 1;
      renderList();
    }
  });
  nextBtn.addEventListener('click', () => {
    if (page > 0) {
      page -= 1;
      renderList();
    }
  });
  newestBtn.addEventListener('click', () => {
    page = 0;
    renderList();
  });

  container.textContent = '';
  const view = h('div', { class: 'rc-view-fill' },
    h('h1', { class: 'rc-title' }, 'Live traffic'),
    h('p', { class: 'rc-sub' }, 'Every request the game and players make, in real time — paginated, newest first.'),
    toolbar,
    list,
    footer,
  );
  container.append(view);

  renderList();

  source = new EventSource('/__events');
  source.onmessage = (event) => {
    try {
      const entry = JSON.parse(event.data) as CapturedRequest;
      entries.push(entry);
      if (entries.length > MAX_BUFFER) entries = entries.slice(-MAX_BUFFER);
      if (live && page === 0) {
        renderList();
      } else {
        updateCountLabel();
      }
    } catch {
      // ignore malformed frames
    }
  };
}

function applyFilter(all: CapturedRequest[]): CapturedRequest[] {
  if (!filterValue) return all;
  return all.filter((entry) =>
    `${entry.method} ${entry.path} ${entry.rpc?.call ?? ''} ${entry.account?.username ?? ''}`.toLowerCase().includes(filterValue),
  );
}

function totalPages(): number {
  return Math.max(1, Math.ceil(applyFilter(entries).length / PAGE_SIZE));
}

function updateCountLabel(): void {
  const count = document.getElementById('traffic-count');
  if (!count) return;
  const filtered = applyFilter(entries);
  const rpc = entries.filter((entry) => entry.kind === 'rpc').length;
  const misses = entries.filter((entry) => entry.status === 404).length;
  count.textContent = `${fmt(entries.length)} buffered · ${fmt(filtered.length)} shown · ${fmt(rpc)} RPC · ${fmt(misses)} 404`;
}

function renderList(): void {
  const list = document.getElementById('traffic-list');
  if (!list) return;

  const filtered = applyFilter(entries);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(Math.max(0, page), pages - 1);

  // Newest first, then slice the current page.
  const newestFirst = filtered.slice().reverse();
  const slice = newestFirst.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const fragment = document.createDocumentFragment();
  for (const entry of slice) fragment.append(row(entry));

  list.textContent = '';
  list.append(fragment);

  updateCountLabel();

  const pageLabel = document.getElementById('traffic-page');
  if (pageLabel) {
    pageLabel.textContent = `page ${page + 1} / ${pages}${page === 0 && live ? ' (live)' : ''}`;
  }
  const prev = document.getElementById('traffic-prev');
  const next = document.getElementById('traffic-next');
  const newest = document.getElementById('traffic-newest');
  if (prev) prev.style.visibility = page < pages - 1 ? 'visible' : 'hidden';
  if (next) next.style.visibility = page > 0 ? 'visible' : 'hidden';
  if (newest) newest.style.visibility = page === 0 && live ? 'hidden' : 'visible';
}

function row(entry: CapturedRequest): HTMLElement {
  const method = entry.method || '?';
  const statusClass = entry.status >= 500 ? 'err' : entry.status === 404 ? 'warn' : entry.kind === 'rpc' ? 'rpc' : 'ok';
  const time = new Date(entry.time).toLocaleTimeString('en-GB');
  const summary = entry.kind === 'rpc' && entry.rpc
    ? entry.rpc.subs?.length
      ? `${entry.rpc.call} (${entry.rpc.subs.length} calls: ${entry.rpc.subs.map((sub) => `${sub.name}${sub.answered === 'ok' ? '' : '=ERR'}`).join(', ')})`
      : `${entry.rpc.call} → ${entry.rpc.answered || entry.rpc.error || ''}`
    : `${method} ${entry.path}${entry.matched ? ` → ${entry.matched}` : ''}`;

  const head = h('div', { class: 'rc-request-head' },
    h('span', { class: `rc-method ${statusClass}` }, method),
    h('span', { class: 'rc-status' }, String(entry.status)),
    entry.account ? h('span', { class: 'rc-user', title: `uid ${entry.account.networkUid}` }, entry.account.username) : null,
    h('span', { class: 'rc-summary' }, summary),
    h('span', { class: 'rc-time' }, time),
    entry.bodyLen ? h('span', { class: 'rc-size' }, `${fmt(entry.bodyLen)}B`) : null,
  );
  const box = h('div', { class: 'rc-request' });
  box.append(head);

  head.addEventListener('click', () => {
    const detail = box.querySelector('.rc-request-detail');
    if (detail) {
      detail.remove();
      expanded.delete(entry.id);
    } else {
      expanded.add(entry.id);
      box.append(h('div', { class: 'rc-request-detail' }, h('pre', {}, detailText(entry))));
    }
  });
  return box;
}

function detailText(entry: CapturedRequest): string {
  const lines = [
    `#${entry.id}  ${entry.method} ${entry.rawUrl || entry.path}`,
    `time: ${entry.time}`,
    `status: ${entry.status}  kind: ${entry.kind}  body: ${entry.bodyLen}B${entry.respLen != null ? `  resp: ${entry.respLen}B` : ''}`,
    `matched: ${entry.matched ?? '—'}`,
  ];
  if (entry.account) lines.push(`account: ${entry.account.username} (uid ${entry.account.networkUid})`);
  lines.push(`duration: ${entry.durationMs.toFixed(1)}ms`);
  if (entry.rpc?.subs?.length) {
    lines.push('rpc subs:');
    for (const sub of entry.rpc.subs) lines.push(`  ${sub.name}  ${sub.answered}`);
  }
  if (entry.bodyText) lines.push('body:', entry.bodyText.slice(0, 4000));
  if (entry.query && Object.keys(entry.query).length) lines.push(`query: ${JSON.stringify(entry.query)}`);
  return lines.join('\n');
}

function copyText(entry: CapturedRequest): string {
  return detailText(entry);
}
