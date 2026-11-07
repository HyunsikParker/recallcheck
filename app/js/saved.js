// Saved items: barcodes and name searches the user wants checked again later.
// The list lives only in this browser (localStorage). Each item remembers which recall notices it
// already matched, so a later check can point out notices published since it was saved.

export const STORAGE_KEY = 'rc-saved-v1';
export const MAX_ITEMS = 30;
export const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;

const same = (a, b) => a.kind === b.kind && a.value === b.value;

export function parse(text) {
  try {
    const data = JSON.parse(text || 'null');
    if (!data || !Array.isArray(data.items)) return { items: [], checkedAt: null };
    const items = data.items.filter((i) => i && (i.kind === 'upc' || i.kind === 'name') && typeof i.value === 'string')
      .map((i) => ({
        kind: i.kind, value: i.value, label: String(i.label || i.value),
        savedAt: i.savedAt || null,
        seen: Array.isArray(i.seen) ? i.seen.map(String) : [],
        fresh: Array.isArray(i.fresh) ? i.fresh.map(String) : [],
      }));
    return { items, checkedAt: data.checkedAt || null };
  } catch {
    return { items: [], checkedAt: null };
  }
}

export const serialise = (list) => JSON.stringify(list);

export function has(list, item) {
  return list.items.some((i) => same(i, item));
}

// Add or refresh an item. The recall notices it matches now count as already seen.
export function add(list, { kind, value, label }, keys, now = new Date().toISOString()) {
  const rest = list.items.filter((i) => !same(i, { kind, value }));
  const item = { kind, value, label, savedAt: now, seen: [...new Set(keys)], fresh: [] };
  return { ...list, items: [item, ...rest].slice(0, MAX_ITEMS) };
}

export function remove(list, item) {
  return { ...list, items: list.items.filter((i) => !same(i, item)) };
}

// Record a new check of one item. Keys not seen before become "fresh" and stay fresh until the
// user marks them read, so a notice is not lost if the page is closed right after a check.
export function record(list, item, keys) {
  const items = list.items.map((i) => {
    if (!same(i, item)) return i;
    const seen = new Set(i.seen);
    const fresh = new Set(i.fresh);
    for (const k of keys) if (!seen.has(k)) fresh.add(k);
    return { ...i, fresh: [...fresh] };
  });
  return { ...list, items };
}

export function markRead(list, item) {
  const items = list.items.map((i) => (same(i, item) ? { ...i, seen: [...new Set([...i.seen, ...i.fresh])], fresh: [] } : i));
  return { ...list, items };
}

export const stamp = (list, now = new Date().toISOString()) => ({ ...list, checkedAt: now });

export function due(list, now = Date.now()) {
  if (!list.items.length) return false;
  const last = list.checkedAt ? Date.parse(list.checkedAt) : NaN;
  return Number.isNaN(last) || now - last >= RECHECK_AFTER_MS;
}

/* ---------- storage (any failure means "storage unavailable", never a crash) ---------- */
export function load(storage) {
  try { return parse(storage.getItem(STORAGE_KEY)); } catch { return null; }
}
export function store(storage, list) {
  try { storage.setItem(STORAGE_KEY, serialise(list)); return true; } catch { return false; }
}
