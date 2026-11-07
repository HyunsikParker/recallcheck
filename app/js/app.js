import { normaliseScanned } from './upc.js';
import { loadIndex, topUp, lookupUpc, searchName, searchFdaLive, meta, liveState, card, cardsFrom } from './data.js';
import { modelTokens, rankByTokens } from './labeltext.js';
import { readFromFile, startCamera, stopCamera } from './scan.js';
import * as saved from './saved.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const resultsEl = $('results');

/* ---------- small DOM helpers (textContent only) ---------- */
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
function fact(label, value, cls) {
  if (!value) return null;
  return el('div', { class: `fact ${cls || ''}`.trim() }, el('dt', { text: label }), el('dd', { text: value }));
}
const prettyDate = (s) => {
  if (!s) return '';
  const d = s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
  const dt = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const spacedUpc = (g) => {
  const c = g.replace(/^0+(?=\d{12}$)/, '');
  return c.length === 12 ? `${c[0]} ${c.slice(1, 6)} ${c.slice(6, 11)} ${c[11]}` : c;
};
function setStatus(text, progress) {
  statusEl.replaceChildren();
  if (text) statusEl.append(text);
  if (progress != null) statusEl.append(el('progress', { max: '1', value: String(progress), 'aria-hidden': 'true' }));
}
function show(...panels) {
  resultsEl.replaceChildren(...panels);
  resultsEl.focus({ preventScroll: true });
  resultsEl.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function panel(kind, title, verdict, verdictNote, body) {
  return el('article', { class: `facts ${kind}` },
    el('h3', { text: title }),
    el('div', { class: 'bar', 'aria-hidden': 'true' }),
    el('p', { class: 'verdict' }, el('span', { text: verdict }), verdictNote ? el('small', { text: verdictNote }) : null),
    ...body);
}

/* ---------- recall facts panels ---------- */
function fdaPanel(c) {
  const closed = /terminated|completed/i.test(c.status || '');
  return panel('hit', 'Recall facts', 'Recall found', c.cls ? `FDA ${c.cls}` : 'FDA', [
    el('p', { class: 'callout', text: closed
      ? 'This barcode is listed in a food recall that FDA has since closed. Check the lot codes and dates below against your package.'
      : 'This barcode is listed in a food recall. Check the lot codes and dates below against your package before you eat it.' }),
    el('dl', {},
      fact('Product', c.product),
      fact('Company', c.firm),
      fact('Reason', c.reason),
      fact('Lots and dates', c.codes, 'codes'),
      fact('Sold in', c.area),
      fact('Recall status', c.status),
      fact('Reported', prettyDate(c.date))),
    el('p', { class: 'foot-line' },
      `FDA Enforcement Report, recall number ${c.id}. `,
      el('a', { href: 'https://www.accessdata.fda.gov/scripts/ires/index.cfm', rel: 'noopener', target: '_blank', text: 'Search it on FDA.gov' }),
      c.live ? ' (published after this app was built; found live).' : '.'),
  ]);
}
function cpscPanel(c, kind = 'hit', verdict = 'Recall found', note = 'CPSC') {
  const imgUrl = (c.imgs || []).find(Boolean);
  return panel(kind, 'Recall facts', verdict, note, [
    imgUrl ? el('img', { src: imgUrl, alt: `Recall photo: ${c.product || c.title}`, class: 'recall-photo', loading: 'lazy' }) : null,
    el('dl', {},
      fact('Recall', c.title),
      fact('Product', c.product),
      fact('How to identify it', c.ident, 'lines'),
      fact('Hazard', c.hazard),
      fact('What to do', c.remedy),
      fact('Units', c.units),
      fact('Sold at', c.sold),
      fact('Recalled', prettyDate(c.date))),
    el('p', { class: 'foot-line' },
      `CPSC recall ${c.id}. `,
      c.url ? el('a', { href: c.url, rel: 'noopener', target: '_blank', text: 'Read the official notice' }) : null),
  ]);
}
const fdaFrom = (m) => (m.fda_earliest_report_date || '2020').slice(0, 4);
const cpscFrom = (m) => (m.cpsc_earliest_recall_date || '2022').slice(0, 4);
function recordsLine() {
  const m = meta();
  const l = liveState();
  const base = `Searched ${m.fda_reports_with_upc.toLocaleString('en-US')} FDA food recall reports that list a barcode (${fdaFrom(m)} to ${prettyDate(m.fda_latest_report_date)}) and ${m.cpsc_recalls_read.toLocaleString('en-US')} CPSC product recalls (${cpscFrom(m)} to ${prettyDate(m.cpsc_latest_recall_date)}).`;
  if (!l.checkedAt) return base;
  if (l.error) return `${base} ${l.error}`;
  const t = l.checkedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${base} Newer notices checked live at ${t}.`;
}

/* ---------- barcode ---------- */
async function checkBarcode(raw, format) {
  const gtin = normaliseScanned(raw, format);
  if (!gtin) {
    show(panel('maybe', 'Barcode', 'That number is not a valid barcode', null, [
      el('p', { text: 'Type all the digits under the bars, including the small ones at each end. Most food packages have 12 or 13.' })]));
    setStatus('');
    return;
  }
  setStatus('Checking recall records…');
  await loadIndex();
  await topUp();
  const hits = lookupUpc(gtin);
  setStatus('');
  if (hits.length) {
    const render = (h) => (h.src === 'FDA' ? fdaPanel(h) : cpscPanel(h));
    const head = hits.length > 1 ? el('p', { class: 'status', text: `${hits.length} recall notices list barcode ${spacedUpc(gtin)}. The newest is first.` }) : null;
    const older = hits.length > 1
      ? el('details', { class: 'older' }, el('summary', { text: `Show ${hits.length - 1} older notice${hits.length > 2 ? 's' : ''} for this barcode` }), ...hits.slice(1).map(render))
      : null;
    show(...[head, render(hits[0]), older, saveControl(upcItem(gtin), hits.map((h) => h.key))].filter(Boolean));
    return;
  }
  show(...[panel('clear', 'Recall facts', 'No recall found for this barcode', spacedUpc(gtin), [
    el('p', { class: 'callout', text: 'Not finding a barcode does not mean the item is safe. Many recall notices list no barcode at all, especially for household products.' }),
    el('p', { text: recordsLine() }),
    el('p', {}, 'For furniture, toys, electronics and other products, try ',
      el('button', { type: 'button', class: 'linkish', 'data-go': 'photo', text: 'Photo' }), ' or ',
      el('button', { type: 'button', class: 'linkish', 'data-go': 'name', text: 'Name' }), '.'),
  ]), saveControl(upcItem(gtin), [])].filter(Boolean));
}
const upcItem = (gtin) => ({ kind: 'upc', value: gtin, label: `Barcode ${spacedUpc(gtin)}` });

$('upc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  checkBarcode($('upc-input').value).catch(fail);
});

$('barcode-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  setStatus('Reading the barcode in your photo…');
  try {
    const code = await readFromFile(f);
    if (!code) {
      setStatus('');
      show(panel('maybe', 'Barcode', 'No barcode found in that photo', null, [
        el('p', { text: 'Take the photo straight on, close enough that the bars fill most of the frame, in good light. Or type the numbers under the bars.' })]));
      return;
    }
    $('upc-input').value = code.text;
    await checkBarcode(code.text, code.format);
  } catch (err) { fail(err); }
});

const video = $('camera');
$('scan-start').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    show(panel('maybe', 'Camera', 'This browser cannot open the camera here', null, [
      el('p', { text: 'Type the numbers under the barcode, or use “Read a barcode from a saved photo”.' })]));
    return;
  }
  $('viewfinder').hidden = false;
  $('scan-start').hidden = true;
  setStatus('Point the camera at the barcode.');
  try {
    await startCamera(video, (code) => {
      $('viewfinder').hidden = true;
      $('scan-start').hidden = false;
      $('upc-input').value = code.text;
      checkBarcode(code.text, code.format).catch(fail);
    });
  } catch (err) {
    stopCamera(video);
    $('viewfinder').hidden = true;
    $('scan-start').hidden = false;
    setStatus('');
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    show(panel('maybe', 'Camera', denied ? 'Camera access is off' : 'The camera could not start', null, [
      el('p', { text: denied
        ? 'Allow camera access for this site in your browser settings, or type the numbers under the barcode instead.'
        : 'Another app may be using it. Type the numbers under the barcode instead, or read the barcode from a saved photo.' })]));
  }
});
$('camera-stop').addEventListener('click', () => {
  stopCamera(video);
  $('viewfinder').hidden = true;
  $('scan-start').hidden = false;
  setStatus('');
  $('scan-start').focus();
});

/* ---------- name search ---------- */
$('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('name-input').value.trim();
  if (!q) return;
  setStatus('Searching recall records…');
  try {
    await loadIndex();
    await topUp();
    const local = searchName(q, 30);
    const cpsc = local.filter((c) => c.src === 'CPSC');
    let fda = { total: 0, items: [] }, liveOk = true;
    try { fda = await searchFdaLive(q, 6); } catch { liveOk = false; fda.items = local.filter((c) => c.src === 'FDA').slice(0, 6); fda.total = fda.items.length; }
    setStatus('');
    const item = { kind: 'name', value: q, label: `“${q}”` };
    const keys = [...cpsc, ...fda.items].map((c) => c.key);
    if (!cpsc.length && !fda.items.length) {
      show(...[panel('clear', 'Name search', 'No recall found with those words', `“${q}”`, [
        el('p', { class: 'callout', text: 'Not finding a name does not mean the item is safe. Try the brand alone, or the model number printed on the label.' }),
        el('p', { text: recordsLine() })]), saveControl(item, keys)].filter(Boolean));
      return;
    }
    const parts = [el('p', { class: 'callout', text: 'A name match is not a match for your item. Compare the model number, lot code or date on your item with the notice.' })];
    if (cpsc.length) {
      parts.push(el('h4', { class: 'group', text: `Household products: ${cpsc.length > 6 ? 'the 6 best of ' + cpsc.length : cpsc.length} CPSC recall${cpsc.length > 1 ? 's' : ''} since ${cpscFrom(meta())}` }));
      parts.push(...cpsc.slice(0, 6).map((c) => compactItem(c)));
    }
    if (fda.items.length) {
      const label = liveOk
        ? `Food: the newest ${fda.items.length} of ${fda.total.toLocaleString('en-US')} FDA reports since 2012`
        : `Food: ${fda.items.length} FDA reports from this build (the live FDA search did not answer)`;
      parts.push(el('h4', { class: 'group', text: label }));
      parts.push(...fda.items.map((c) => compactItem(c)));
    }
    show(...[panel('maybe', 'Name search', `Recalls that mention “${q}”`, null, parts), saveControl(item, keys)].filter(Boolean));
  } catch (err) { fail(err); }
});

/* ---------- saved items: checked again on later visits ---------- */
let savedList = null; // null when this browser blocks storage
let storage = null;
try { storage = window.localStorage; savedList = saved.load(storage); } catch { /* storage blocked */ }
const knownCards = new Map(); // cards fetched live this visit, for notices not in the shipped index
let savedChecking = false;
let savedError = '';
const DAY = 864e5;
const dateMs = (s) => (/^\d{8}$/.test(s || '') ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : Date.parse(s || ''));
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function persist() {
  if (!saved.store(storage, savedList)) savedError = 'This browser did not keep the change. Saved items may be lost when the page closes.';
}

function saveControl(item, keys) {
  if (!savedList) return null;
  const done = () => { btn.textContent = 'Saved'; btn.setAttribute('aria-disabled', 'true'); note.textContent = 'It is listed under Saved items at the top of the page.'; };
  const btn = el('button', { type: 'button', class: 'quiet', text: item.kind === 'upc' ? 'Save this barcode' : 'Save this search' });
  const note = el('span', { class: 'hint', text: 'RecallCheck will check it again for new recall notices.' });
  if (saved.has(savedList, item)) done();
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    savedList = saved.add(savedList, item, keys);
    persist();
    done();
    renderSaved();
  });
  return el('div', { class: 'save-row' }, btn, note);
}

async function freshKeysFor(item) {
  let cards;
  if (item.kind === 'upc') cards = lookupUpc(item.value);
  else {
    const local = searchName(item.value, 30);
    cards = local.filter((c) => c.src === 'CPSC');
    try { cards.push(...(await searchFdaLive(item.value, 6)).items); } catch { cards.push(...local.filter((c) => c.src === 'FDA').slice(0, 6)); }
  }
  cards.forEach((c) => knownCards.set(c.key, c));
  // A notice dated well before the item was saved was missed by the earlier search (for example
  // when the live FDA search did not answer), so it is not reported as new.
  const cutoff = Date.parse(item.savedAt || '') - 30 * DAY;
  return cards.filter((c) => { const t = dateMs(c.date); return Number.isNaN(t) || Number.isNaN(cutoff) || t >= cutoff; }).map((c) => c.key);
}

async function checkSaved() {
  if (!savedList?.items.length || savedChecking) return;
  savedChecking = true;
  savedError = '';
  renderSaved();
  try {
    await loadIndex();
    await topUp();
    for (const item of [...savedList.items]) savedList = saved.record(savedList, item, await freshKeysFor(item));
    savedList = saved.stamp(savedList);
    persist();
    if (liveState().error) savedError = 'Newer notices could not be checked just now, so this check used the records in this build.';
  } catch (err) {
    console.warn(err);
    savedError = navigator.onLine ? 'The saved items could not be checked just now. Try again later.' : 'You appear to be offline. Saved items are checked again when you reconnect and reopen RecallCheck.';
  } finally {
    savedChecking = false;
    renderSaved();
  }
}

function renderSaved() {
  const sec = $('saved');
  if (!savedList?.items.length) { sec.hidden = true; $('saved-list').replaceChildren(); return; }
  sec.hidden = false;
  const fresh = savedList.items.reduce((n, i) => n + i.fresh.length, 0);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let sum;
  if (savedChecking) sum = `Checking ${plural(savedList.items.length, 'saved item')}…`;
  else if (fresh) sum = `${plural(fresh, 'new recall notice')} for your saved items.`;
  else if (savedList.checkedAt) sum = `No new recall notices. Last checked ${new Date(savedList.checkedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
  else sum = `${plural(savedList.items.length, 'saved item')}, not checked again yet.`;
  const sumEl = $('saved-sum');
  sumEl.className = fresh && !savedChecking ? 'saved-sum fresh' : 'saved-sum';
  sumEl.textContent = savedError ? `${sum} ${savedError}` : sum;
  $('saved-check').setAttribute('aria-disabled', String(savedChecking));
  $('saved-list').replaceChildren(...savedList.items.map((i) => {
    const remove = el('button', { type: 'button', class: 'linkish', 'aria-label': `Remove ${i.label}`, text: 'Remove' });
    remove.addEventListener('click', () => {
      savedList = saved.remove(savedList, i);
      persist();
      renderSaved();
      (document.querySelector('.saved-list .linkish') || (savedList.items.length ? $('saved-check') : document.querySelector('[role="tab"][aria-selected="true"]')))?.focus();
    });
    const since = i.savedAt ? ` since you saved it on ${shortDate(i.savedAt)}` : '';
    const notices = i.fresh.map((k) => {
      const c = knownCards.get(k) || card(k);
      return c ? compactItem(c, 'New since you saved it') : el('p', { text: `Recall notice ${k.replace(':', ' ').toUpperCase()}. Tap “Check now” to show it.` });
    });
    let read = null;
    if (i.fresh.length) {
      read = el('button', { type: 'button', class: 'quiet', text: 'Mark as read' });
      read.addEventListener('click', () => { savedList = saved.markRead(savedList, i); persist(); renderSaved(); $('saved-check').focus(); });
    }
    return el('li', { class: i.fresh.length ? 'saved-item fresh' : 'saved-item' },
      el('div', { class: 'saved-row' }, el('span', { class: 'saved-label', text: i.label }), remove),
      el('p', { class: 'saved-state', text: i.fresh.length ? `${plural(i.fresh.length, 'new recall notice')}${since}.` : `No new recall notice${since}.` }),
      ...notices, read);
  }));
}

$('saved-check').addEventListener('click', () => {
  if ($('saved-check').getAttribute('aria-disabled') !== 'true') checkSaved();
});
renderSaved();
if (savedList && saved.due(savedList)) checkSaved();

/* ---------- photo search ---------- */
let photoRun = 0; // a newer photo cancels the label reading of an older one
$('photo-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  const run = ++photoRun;
  const prevUrl = URL.createObjectURL(f);
  $('photo-preview-img').src = prevUrl;
  $('photo-preview').hidden = false;
  try {
    const photo = await import('./photo.js');
    setStatus('Loading recall photos…');
    await Promise.all([loadIndex(), photo.loadPhotoIndex()]);
    setStatus('Loading the image model (first time only)…', 0);
    const q = await photo.embedPhoto(f, (p) => setStatus(`Loading the image model (first time only): ${Math.round(p * 100)}%`, p));
    setStatus('Comparing with recall photos…');
    const top = photo.rankRecalls(q, 5);
    const th = photo.thresholds();
    setStatus('');
    renderPhotoMatches(top, th);
    await readLabel(f, run);
  } catch (err) { if (run === photoRun) fail(err); }
});

// After the look-alikes are shown, read any printed text on the same photo. A model number that a
// recall notice names is stronger evidence than a look-alike, so those recalls go on top.
async function readLabel(f, run) {
  const note = $('label-note');
  try {
    const ocr = await import('./ocr.js');
    setStatus('Reading any label text on your photo…', 0);
    const text = await ocr.readText(f, (what, p) => {
      if (run === photoRun) setStatus(what === 'recognizing text' ? 'Reading any label text on your photo…' : 'Loading the text reader (first time only)…', p);
    });
    if (run !== photoRun) return;
    setStatus('');
    const tokens = modelTokens(text);
    const named = rankByTokens(tokens, cardsFrom('CPSC')).slice(0, 3);
    if (named.length) {
      const n = named.length;
      resultsEl.prepend(panel('hit', 'Label check', `Model number named in ${n} recall${n > 1 ? 's' : ''}`, 'Read on your phone', [
        el('p', { class: 'callout', text: 'RecallCheck read a model or item number on your photo that a recall notice names. Check the notice before you act: some recalls cover only certain dates or serial numbers, and text reading can make mistakes.' }),
        ...named.map((m) => compactItem(m.card, `Your photo shows ${m.hits.join(', ')}`)),
      ]));
      setStatus(`Found a model number named in ${n} recall${n > 1 ? 's' : ''}.`);
      note?.remove();
    } else if (note) {
      // Unmatched words are often misread print, so they are not listed.
      note.textContent = tokens.length
        ? 'RecallCheck read some text on your photo, but no recall notice in these records names a model number in it.'
        : 'No model number could be read on your photo. A close, sharp photo of the label lets RecallCheck read it.';
    }
  } catch (err) {
    console.warn(err);
    if (run !== photoRun) return;
    setStatus('');
    if (note) note.textContent = 'The label text could not be read this time. The look-alikes above are still valid.';
  }
}

function renderPhotoMatches(top, th) {
  const alike = top.filter((m) => m.sim >= th.close).length;
  const kind = alike ? 'maybe' : 'clear';
  const verdict = alike ? `${alike} look-alike recall${alike > 1 ? 's' : ''}` : 'No close look-alike';
  const intro = alike
    ? 'Some recall photos look like your photo. A look-alike is not a match: open "How to tell if yours is included" and compare the model number, label or color with your item.'
    : 'No recall photo looks very much like yours. The five nearest are below in case one is your item. Not finding a match does not mean the item is safe.';
  const list = top.map((m) => {
    const c = card(`cpsc:${m.rid}`);
    if (!c) return null;
    const strength = m.sim >= th.strong ? 'Very close look-alike' : m.sim >= th.close ? 'Look-alike' : 'Less alike';
    return compactItem(c, strength, c.imgs?.[m.img]);
  }).filter(Boolean);
  show(panel(kind, 'Photo search', verdict, 'CPSC photos', [
    el('p', { class: 'callout', text: intro }),
    el('p', { class: 'label-note', id: 'label-note', text: 'Reading any label text on your photo…' }),
    ...list]));
}

// One recall as a short row: photo, name, what to compare, link to the official notice.
function compactItem(c, strength, imgUrl) {
  const img = imgUrl || (c.imgs || []).find(Boolean);
  const isFda = c.src === 'FDA';
  return el('div', { class: img ? 'match' : 'match text-only' },
    img ? el('img', { src: img, alt: `Recall photo: ${c.product || c.title}`, loading: 'lazy' }) : null,
    el('div', {},
      el('h4', { text: isFda ? c.product : (c.product || c.title) }),
      strength ? el('p', { class: 'strength', text: strength }) : null,
      isFda ? el('p', { text: `${c.firm}. ${c.reason}` }) : null,
      isFda && c.codes ? el('p', { text: `Lots and dates: ${c.codes}` }) : null,
      !isFda && c.hazard ? el('p', { text: c.hazard }) : null,
      el('p', { class: 'meta', text: `${isFda ? 'FDA ' + c.id : 'CPSC ' + c.id}, ${prettyDate(c.date)}` }),
      c.url ? el('p', {}, el('a', { href: c.url, rel: 'noopener', target: '_blank', text: 'Read the official notice' })) : null),
    // full row width, so the notice's own description is readable on a phone
    !isFda && c.ident ? el('details', { class: 'ident' }, el('summary', { text: 'How to tell if yours is included' }), el('p', { text: c.ident })) : null);
}

/* ---------- errors ---------- */
function fail(err) {
  console.error(err);
  setStatus('');
  const offline = !navigator.onLine;
  show(panel('maybe', 'Something went wrong', offline ? 'You appear to be offline' : 'The check did not finish', null, [
    el('p', { text: offline
      ? 'RecallCheck needs a connection the first time to load recall records. Connect and try again.'
      : 'Reload the page and try again. If photo search keeps failing, your browser may not have enough memory for the image model; barcode and name search still work.' })]));
}

/* ---------- tabs ---------- */
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab, focus = true) {
  // The status line describes the last check; it would read as stale next to another way of checking.
  if (tab.getAttribute('aria-selected') !== 'true') setStatus('');
  tabs.forEach((t) => {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !on;
  });
  if (tab.id !== 'tab-barcode') { stopCamera(video); $('viewfinder').hidden = true; $('scan-start').hidden = false; }
  if (focus) tab.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const k = e.key;
    let j = null;
    if (k === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (k === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (k === 'Home') j = 0;
    else if (k === 'End') j = tabs.length - 1;
    if (j != null) { e.preventDefault(); selectTab(tabs[j]); }
  });
});
resultsEl.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (go) { selectTab($(`tab-${go}`)); $('check').scrollIntoView({ block: 'start' }); }
});

/* ---------- theme ---------- */
const themeBtn = $('theme-toggle');
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  themeBtn.textContent = dark ? 'Light' : 'Dark';
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  themeBtn.setAttribute('aria-pressed', String(dark));
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('rc-theme'); } catch { /* storage blocked */ }
applyTheme(savedTheme);
themeBtn.addEventListener('click', () => {
  const dark = themeBtn.getAttribute('aria-pressed') === 'true';
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('rc-theme', next); } catch { /* storage blocked */ }
});

/* ---------- about: sources and measured photo quality ---------- */
(async () => {
  try {
    await loadIndex();
    renderSaved(); // saved notices can now show their titles
    const m = meta();
    $('sources').textContent = `Records in this build: ${m.fda_reports_read.toLocaleString('en-US')} FDA food recall reports from ${fdaFrom(m)} to ${prettyDate(m.fda_latest_report_date)} (${m.fda_reports_with_upc.toLocaleString('en-US')} list a barcode) and ${m.cpsc_recalls_read.toLocaleString('en-US')} CPSC product recalls from ${cpscFrom(m)} to ${prettyDate(m.cpsc_latest_recall_date)}. Newer notices are checked live when you search.`;
    const q = await fetch('data/photo-quality.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (q) $('photo-quality').replaceChildren(qualityTable(q), q.label ? labelTable(q.label) : '');
  } catch { /* the check itself reports load errors */ }
})();

function qualityTable(q) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const keys = [
    ['Same recall ranked first', 'top1'],
    ['Same recall in the top 5', 'top5'],
    ['Items not in the list called a look-alike', 'false_close'],
  ];
  const cols = q.home ? [q, q.home] : [q];
  const head = q.home
    ? el('thead', {}, el('tr', {}, el('td', {}), el('th', { scope: 'col', class: 'num', text: 'Recall photos' }),
        el('th', { scope: 'col', class: 'num', text: 'Home-like copies' })))
    : '';
  return el('table', { class: 'quality' },
    el('caption', { text: 'How well photo search works' }),
    head,
    el('tbody', {}, keys.map(([a, k]) => el('tr', {}, el('th', { scope: 'row', text: a }),
      cols.map((c) => el('td', { class: 'num', text: pct(c[k]) }))))),
    el('tfoot', {}, el('tr', {}, el('td', { colspan: String(cols.length + 1), class: 'note', text: q.note }))));
}
function labelTable(l) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const rows = [
    ['Label photos: same recall first, photo match only', pct(l.image_top1)],
    ['Label photos: same recall first, with the label read', pct(l.fused_top1)],
    ['Model number matches that were the right recall', pct(l.text_precision)],
  ];
  return el('table', { class: 'quality' },
    el('caption', { text: 'How much reading the label helps' }),
    el('tbody', {}, rows.map(([a, b]) => el('tr', {}, el('th', { scope: 'row', text: a }), el('td', { class: 'num', text: b })))),
    el('tfoot', {}, el('tr', {}, el('td', { colspan: '2', class: 'note', text: l.note }))));
}
