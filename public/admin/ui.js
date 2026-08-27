// Small dependency-free DOM/UI helpers for the admin dashboard.
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class')
            node.className = String(value);
        else if (key === 'text')
            node.textContent = String(value);
        else if (value === true)
            node.setAttribute(key, '');
        else if (value === false || value == null)
            continue;
        else
            node.setAttribute(key, String(value));
    }
    for (const child of children) {
        if (child == null || child === false)
            continue;
        node.append(child);
    }
    return node;
}
export function h(tag, attrs = {}, ...children) {
    return el(tag, attrs, ...children);
}
/** Apply a side effect to a node and return it (fluent wiring for listeners). */
export function also(node, fn) {
    fn(node);
    return node;
}
HTMLElement.prototype.also = function (fn) {
    fn(this);
    return this;
};
export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
export function fmt(n) {
    return n == null ? '—' : n.toLocaleString('en-GB');
}
export function fmtBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
export function fmtDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${mins}m`;
    return `${mins}m ${s % 60}s`;
}
export function relTime(unixSeconds) {
    const diff = Date.now() / 1000 - unixSeconds;
    if (diff < 5)
        return 'just now';
    if (diff < 60)
        return `${Math.floor(diff)}s ago`;
    if (diff < 3600)
        return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400)
        return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}
export function isoTime(iso) {
    if (!iso)
        return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB');
}
// ---------- toast ----------
const TOAST_ROOT_ID = 'rc-toast-root';
function toastRoot() {
    let root = document.getElementById(TOAST_ROOT_ID);
    if (!root) {
        root = h('div', { id: TOAST_ROOT_ID });
        document.body.append(root);
    }
    return root;
}
export function toast(message, ok = true) {
    const box = h('div', { class: `rc-toast ${ok ? 'ok' : 'err'}` }, message);
    toastRoot().append(box);
    setTimeout(() => box.classList.add('out'), 2600);
    setTimeout(() => box.remove(), 3100);
}
// ---------- confirm ----------
export function confirmDialog(title, message, danger = false) {
    return new Promise((resolve) => {
        const overlay = h('div', { class: 'rc-modal-overlay' });
        const panel = h('div', { class: 'rc-modal' });
        const cancelBtn = h('button', { class: 'rc-btn', type: 'button' }, 'Cancel');
        const confirmBtn = h('button', { class: `rc-btn ${danger ? 'danger' : 'primary'}`, type: 'button' }, 'Confirm');
        const close = (value) => {
            overlay.remove();
            resolve(value);
        };
        cancelBtn.addEventListener('click', () => close(false));
        confirmBtn.addEventListener('click', () => close(true));
        panel.append(h('h2', {}, title), h('p', { class: 'rc-modal-msg' }, message), h('div', { class: 'rc-modal-actions' }, cancelBtn, confirmBtn));
        overlay.append(panel);
        document.body.append(overlay);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay)
                close(false);
        });
    });
}
// ---------- modal ----------
export function openModal(title, body, onClose) {
    const overlay = h('div', { class: 'rc-modal-overlay' });
    const panel = h('div', { class: 'rc-modal' });
    const close = () => {
        overlay.remove();
        onClose?.();
    };
    panel.append(h('div', { class: 'rc-modal-head' }, h('h2', {}, title), h('button', { class: 'rc-btn icon', type: 'button', 'aria-label': 'Close' }, '✕')), body);
    overlay.append(panel);
    document.body.append(overlay);
    panel.querySelector('.rc-modal-head button')?.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay)
            close();
    });
    return close;
}
export function parseFieldValue(spec, element) {
    if (spec.type === 'bool') {
        return element.checked;
    }
    if (spec.type === 'item') {
        return itemTextToId(element.value);
    }
    if (spec.type === 'player') {
        return playerTextToId(element.value);
    }
    if (spec.type === 'number') {
        const raw = element.value.trim();
        return raw === '' ? (spec.default ?? 0) : Number(raw);
    }
    return element.value;
}
export function renderForm(fields, values, onSubmit, submitLabel = 'Save', formClass = 'rc-form') {
    const form = h('form', { class: formClass });
    const controls = new Map();
    for (const spec of fields) {
        const current = values[spec.key];
        const label = h('label', {}, spec.label);
        if (spec.type === 'item' || spec.type === 'player') {
            const combo = spec.type === 'player'
                ? buildCombobox(spec, () => playerEntries)
                : buildCombobox(spec, () => catalogEntries.map((entry) => ({ id: String(entry.id), label: entry.label, category: entry.category })));
            if (spec.type === 'player') {
                combo.input.placeholder = spec.placeholder || 'Type a player name… (e.g. Mia Cafe)';
            }
            else {
                combo.input.placeholder = spec.placeholder || 'Type a name… (e.g. Apple, Basic Window)';
            }
            combo.input.value = spec.type === 'item' ? itemIdToText(Number(current ?? spec.default ?? 0)) : String(current ?? spec.default ?? '');
            label.append(combo.wrapper);
            if (spec.help)
                label.append(h('small', { class: 'rc-note' }, spec.help));
            form.append(label);
            controls.set(spec.key, combo.input);
            continue;
        }
        let control;
        if (spec.type === 'bool') {
            control = h('input', { type: 'checkbox' });
            control.checked = Boolean(current ?? spec.default ?? false);
            label.append(control);
            label.classList.add('rc-check');
        }
        else if (spec.type === 'select' && spec.options) {
            control = h('select', {});
            for (const option of spec.options) {
                control.append(h('option', { value: option.value }, option.label));
            }
            control.value = String(current ?? spec.default ?? '');
        }
        else if (spec.type === 'textarea') {
            control = h('textarea', { rows: 3 });
            control.value = String(current ?? spec.default ?? '');
        }
        else {
            const attrs = { type: spec.type, class: 'rc-input' };
            if (spec.required)
                attrs.required = true;
            if (spec.placeholder)
                attrs.placeholder = spec.placeholder;
            if (spec.min !== undefined)
                attrs.min = spec.min;
            if (spec.max !== undefined)
                attrs.max = spec.max;
            control = h('input', attrs);
            control.value = String(current ?? spec.default ?? '');
        }
        if (spec.required && (spec.type === 'select' || spec.type === 'textarea'))
            control.required = true;
        if (spec.type !== 'bool') {
            control.classList.add('rc-input');
        }
        if (spec.help) {
            label.append(control, h('small', { class: 'rc-note' }, spec.help));
        }
        else {
            label.append(control);
        }
        form.append(label);
        controls.set(spec.key, control);
    }
    const message = h('div', { class: 'rc-msg', 'aria-live': 'polite' });
    const button = h('button', { class: 'rc-btn primary block', type: 'submit' }, submitLabel);
    form.append(message, button);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        button.disabled = true;
        message.className = 'rc-msg';
        message.textContent = '';
        const collected = {};
        for (const spec of fields) {
            const control = controls.get(spec.key);
            if (control)
                collected[spec.key] = parseFieldValue(spec, control);
        }
        try {
            await onSubmit(collected);
            message.textContent = 'Saved.';
            message.classList.add('ok');
        }
        catch (error) {
            message.textContent = error instanceof Error ? error.message : String(error);
            message.classList.add('error');
        }
        finally {
            button.disabled = false;
        }
    });
    return form;
}
// ---------- small table ----------
export function table(headers, rows, emptyText = 'Nothing here yet.') {
    const tableEl = h('table', { class: 'rc-table' });
    tableEl.append(h('thead', {}, h('tr', {}, ...headers.map((head) => h('th', {}, head)))));
    const body = h('tbody');
    if (rows.length === 0) {
        body.append(h('tr', {}, h('td', { colspan: String(headers.length), class: 'rc-empty' }, emptyText)));
    }
    else {
        for (const row of rows)
            body.append(h('tr', {}, ...row.map((cell) => h('td', {}, cell))));
    }
    tableEl.append(body);
    return tableEl;
}
export function badge(text, kind = 'muted') {
    return h('span', { class: `rc-badge ${kind}` }, text);
}
// ---------- catalog combobox (name-first, nothing truncated) ----------
let catalogEntries = [];
let catalogById = new Map();
let catalogByName = new Map();
let catalogReady = false;
export function ensureCatalogDatalist(items) {
    if (catalogReady)
        return;
    catalogReady = true;
    catalogEntries = items;
    catalogById = new Map(items.map((item) => [item.id, item.label]));
    catalogByName = new Map();
    for (const item of items) {
        const key = item.label.toLowerCase();
        if (!catalogByName.has(key))
            catalogByName.set(key, item.id);
    }
}
/** Display text for an item id: "Apple (4000000)", or "Unknown item (123)". */
export function itemIdToText(id) {
    if (!Number.isInteger(id) || id <= 0)
        return '';
    const label = catalogById.get(id);
    return label ? `${label} (${id})` : `Unknown item (${id})`;
}
/** Resolve user-typed text to an item id: accepts "Name (id)", "Name", or a raw id. */
export function itemTextToId(text) {
    const raw = String(text ?? '').trim();
    if (!raw)
        return 0;
    const trailing = raw.match(/\((\d+)\)\s*$/);
    if (trailing)
        return Number(trailing[1]);
    const asNumber = Number(raw);
    if (Number.isInteger(asNumber) && /^\d+$/.test(raw))
        return asNumber;
    const byName = catalogByName.get(raw.toLowerCase());
    return byName ?? 0;
}
/** Parse a comma-separated list of names/ids (for mail attachments). */
export function itemListTextToIds(text) {
    return String(text ?? '')
        .split(/\s*,\s*/)
        .filter(Boolean)
        .map((token) => itemTextToId(token))
        .filter((id) => id > 0);
}
let playerEntries = [];
/** Feed the player picker with all accounts (uid -> display name). */
export function ensurePlayerDatalist(entries) {
    playerEntries = [...entries];
}
/** Resolve "Name (uid)" (or a bare uid) back to the uid string. */
export function playerTextToId(text) {
    const raw = String(text ?? '').trim();
    if (!raw)
        return '';
    const trailing = raw.match(/\(([^)]+)\)\s*$/);
    return trailing ? trailing[1] : raw;
}
function buildCombobox(spec, getEntries) {
    const input = h('input', { type: 'text', class: 'rc-input', autocomplete: 'off' });
    input.placeholder = spec.placeholder || 'Type to search…';
    const list = h('div', { class: 'rc-combobox-list' });
    const wrapper = h('div', { class: 'rc-combobox' }, input, list);
    let results = [];
    let active = -1;
    const setActive = (index) => {
        active = index;
        const items = list.querySelectorAll('.rc-combobox-item');
        items.forEach((item, i) => item.classList.toggle('active', i === index));
        if (index >= 0 && items[index])
            items[index].scrollIntoView({ block: 'nearest' });
    };
    const select = (index) => {
        const entry = results[index];
        if (entry)
            input.value = `${entry.label} (${entry.id})`;
        list.classList.remove('open');
    };
    const render = () => {
        const query = input.value.trim().toLowerCase();
        results = query
            ? getEntries()
                .filter((entry) => entry.label.toLowerCase().includes(query) || entry.id.includes(query))
                .slice(0, 30)
            : getEntries().slice(0, 30);
        active = -1;
        list.textContent = '';
        if (results.length === 0) {
            list.append(h('div', { class: 'rc-combobox-empty' }, 'No matches — you can still type the id directly.'));
            return;
        }
        results.forEach((entry, index) => {
            const item = h('div', { class: 'rc-combobox-item' }, h('span', { class: 'rc-combobox-name' }, entry.label), h('span', { class: 'rc-combobox-id' }, entry.id), entry.category ? h('span', { class: 'rc-combobox-cat' }, entry.category) : null);
            item.addEventListener('mousedown', (event) => {
                event.preventDefault();
                select(index);
            });
            item.addEventListener('mouseenter', () => setActive(index));
            list.append(item);
        });
        setActive(-1);
    };
    const open = () => {
        list.classList.add('open');
        render();
    };
    input.addEventListener('focus', open);
    input.addEventListener('input', () => {
        list.classList.add('open');
        render();
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!list.classList.contains('open')) {
                open();
                return;
            }
            setActive(Math.min(active + 1, results.length - 1));
        }
        else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(Math.max(active - 1, 0));
        }
        else if (event.key === 'Enter') {
            if (list.classList.contains('open') && active >= 0) {
                event.preventDefault();
                select(active);
            }
        }
        else if (event.key === 'Escape') {
            list.classList.remove('open');
        }
    });
    input.addEventListener('blur', () => setTimeout(() => list.classList.remove('open'), 150));
    return { wrapper, input };
}
