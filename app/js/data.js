// Recall data: the shipped index plus a live top-up from openFDA and CPSC for notices newer than the build.
import { extractUpcs, normaliseScanned } from './upc.js';

let index = null; // { meta, upc: {gtin14: [key]} }
let recalls = null; // key -> card
let live = { checkedAt: null, fdaAdded: 0, cpscAdded: 0, error: null };
let livePromise = null;

export async function loadIndex() {
  if (index) return;
  const [u, r] = await Promise.all([
    fetch('data/upc-index.json').then((x) => { if (!x.ok) throw new Error('index'); return x.json(); }),
    fetch('data/recalls.json').then((x) => { if (!x.ok) throw new Error('recalls'); return x.json(); }),
  ]);
  index = u;
  recalls = r;
}

export function meta() { return index?.meta; }
export function liveState() { return live; }
export function card(key) { return recalls?.[key]; }
export function cardsFrom(src) { return Object.values(recalls || {}).filter((c) => c.src === src); }

const ymd = (s) => s.replace(/-/g, '').slice(0, 8);
function dayAfter(yyyymmdd) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + 1));
  return d.toISOString().slice(0, 10);
}
// Collapse whitespace; when cut, end on a whole word and mark the cut with an ellipsis.
const clip = (s, n) => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
};
// Like clip, but keeps line breaks and turns table cells (tabs) into "cell: cell", so model lists stay readable.
const clipLines = (s, n) => {
  const t = (s || '').replace(/\r/g, '').replace(/ *\t+ */g, ': ').replace(/[ \u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
};

function addKey(gtin, key) {
  const list = (index.upc[gtin] ||= []);
  if (!list.includes(key)) list.push(key);
}

async function topUpFda() {
  const from = ymd(dayAfter(index.meta.fda_latest_report_date));
  const url = `https://api.fda.gov/food/enforcement.json?search=report_date:[${from}+TO+20991231]&limit=1000`;
  const res = await fetch(url);
  if (res.status === 404) return 0; // openFDA answers 404 when nothing matches
  if (!res.ok) throw new Error(`FDA ${res.status}`);
  const body = await res.json();
  let added = 0;
  for (const r of body.results || []) {
    const key = `fda:${r.recall_number}`;
    const upcs = extractUpcs(`${r.product_description || ''} ${r.code_info || ''}`);
    if (!upcs.length) continue;
    recalls[key] = {
      src: 'FDA', id: r.recall_number, date: r.report_date, firm: clip(r.recalling_firm, 80),
      product: clip(r.product_description, 240), reason: clip(r.reason_for_recall, 240), cls: r.classification,
      status: r.status, area: clip(r.distribution_pattern, 120), codes: clip(r.code_info, 320), live: true,
    };
    upcs.forEach((u) => addKey(u.gtin14, key));
    added++;
  }
  return added;
}

async function topUpCpsc() {
  const from = dayAfter(ymd(index.meta.cpsc_latest_recall_date));
  const res = await fetch(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=${from}`);
  if (!res.ok) throw new Error(`CPSC ${res.status}`);
  const list = await res.json();
  let added = 0;
  for (const r of list || []) {
    const key = `cpsc:${r.RecallID}`;
    if (recalls[key]) continue;
    recalls[key] = {
      src: 'CPSC', id: r.RecallNumber, rid: r.RecallID, date: (r.RecallDate || '').slice(0, 10), title: clip(r.Title, 200),
      product: clip((r.Products || []).map((p) => p.Name).filter(Boolean).join('; '), 200),
      ident: clipLines(r.Description, 1200),
      hazard: clip((r.Hazards || []).map((h) => h.Name).join(' '), 260),
      remedy: clip((r.Remedies || []).map((h) => h.Name).join(' '), 260),
      units: clip((r.Products || []).map((p) => p.NumberOfUnits).filter(Boolean).join('; '), 80),
      sold: clip((r.Retailers || []).map((x) => x.Name).join('; '), 160),
      url: /^https:\/\/(www\.)?cpsc\.gov\//.test(r.URL || '') ? r.URL : null, imgs: [], live: true,
    };
    (r.ProductUPCs || []).forEach((u) => { const g = normaliseScanned(u.UPC); if (g) addKey(g, key); });
    added++;
  }
  return added;
}

// Fetch notices published after the build, once per page load. Failures are reported, not fatal.
export function topUp() {
  if (!livePromise) {
    livePromise = (async () => {
      const [f, c] = await Promise.allSettled([topUpFda(), topUpCpsc()]);
      live = {
        checkedAt: new Date(),
        fdaAdded: f.status === 'fulfilled' ? f.value : 0,
        cpscAdded: c.status === 'fulfilled' ? c.value : 0,
        error: f.status === 'rejected' || c.status === 'rejected' ? 'Newer notices could not be checked just now.' : null,
      };
      return live;
    })();
  }
  return livePromise;
}

export function lookupUpc(gtin14) {
  const keys = index.upc[gtin14] || [];
  return keys.map((k) => ({ key: k, ...recalls[k] })).sort((a, b) => ymd(b.date).localeCompare(ymd(a.date)));
}

// Name search over recall titles, products, descriptions (which hold model numbers) and firms.
// Every query word must appear, or the whole query must appear as a model number once spaces and
// dashes are ignored (KTCS17 finds KT-CS17).
const flatCache = new Map(); // key -> searchable text without spaces or punctuation
export function searchName(q, limit = 8) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sq = squash(q);
  const modelLike = sq.length >= 4 && /\d/.test(sq);
  const out = [];
  for (const [key, c] of Object.entries(recalls)) {
    const hay = `${c.title || ''} ${c.product || ''} ${c.ident || ''} ${c.firm || ''}`.toLowerCase();
    let flat = flatCache.get(key);
    if (flat === undefined) { flat = squash(hay); flatCache.set(key, flat); }
    const modelHit = modelLike && flat.includes(sq);
    if (!modelHit && !words.every((w) => hay.includes(w))) continue;
    let score = words.length;
    // Words in the name count more than words only in the description.
    const name = `${c.title || ''} ${c.product || ''}`.toLowerCase();
    score += words.filter((w) => name.includes(w)).length;
    if (modelHit) score += 5;
    out.push({ key, score, ...c });
  }
  out.sort((a, b) => b.score - a.score || ymd(b.date).localeCompare(ymd(a.date)));
  return out.slice(0, limit);
}

// Live name search over every openFDA food enforcement report (2012 onward), newest first.
// Returns { total, items } or throws; the caller falls back to the shipped records.
export async function searchFdaLive(q, limit = 6) {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 6);
  if (!words.length) return { total: 0, items: [] };
  const term = words.map((w) => `(product_description:${w}+recalling_firm:${w})`).join('+AND+');
  const res = await fetch(`https://api.fda.gov/food/enforcement.json?search=${term}&sort=report_date:desc&limit=${limit}`);
  if (res.status === 404) return { total: 0, items: [] };
  if (!res.ok) throw new Error(`FDA ${res.status}`);
  const body = await res.json();
  const items = (body.results || []).map((r) => ({
    key: `fda:${r.recall_number}`, src: 'FDA', id: r.recall_number, date: r.report_date, firm: clip(r.recalling_firm, 80),
    product: clip(r.product_description, 240), reason: clip(r.reason_for_recall, 240), cls: r.classification,
    status: r.status, area: clip(r.distribution_pattern, 120), codes: clip(r.code_info, 320), live: true,
  }));
  return { total: body.meta?.results?.total || items.length, items };
}
