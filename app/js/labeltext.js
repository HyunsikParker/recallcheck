// Model-number words in label text (from OCR or typed) and recall ranking by those words.
// Shared by the browser and tools/eval_ocr.mjs.

const UNIT = /^\d+(\.\d+)?(IN|INCH|INCHES|CC|V|VAC|VDC|W|MM|CM|M|LB|LBS|OZ|FT|MAH|HZ|A|KG|G|ML|L|PCS|PC|PK|CT|QT|GAL|MPH|PSI|ST|ND|RD|TH|S)$/;
const DATE = /^\d{1,4}[\/.-]\d{1,2}([\/.-]\d{1,4})?$/;
const squash = (s) => s.replace(/[^A-Z0-9]/g, '');

// Words that look like model, item or style numbers: letters and digits, or five or more digits.
export function modelTokens(text) {
  const out = new Set();
  for (const raw of (text || '').toUpperCase().match(/[A-Z0-9][A-Z0-9./-]*[A-Z0-9]/g) || []) {
    const t = squash(raw);
    if (t.length < 4 || t.length > 20 || !/\d/.test(t)) continue;
    if (!/[A-Z]/.test(t) && t.length < 5) continue; // bare 4-digit numbers: years, sizes, counts
    if (!/[A-Z]/.test(t) && (t.match(/0/g) || []).length * 2 >= t.length) continue; // mostly zeros: 30000, 000001
    if (/^\d[A-Z]{4,}$/.test(t)) continue; // a number followed by a word: "4-DIGIT", "2PACK"
    // dates written without separators: MMYYYY (092021) and MMDDYY (112022)
    if (/^(0[1-9]|1[0-2])(19|20)\d\d$/.test(t) || /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d\d$/.test(t)) continue;
    if (/^(19|20)\d\d$/.test(t) || DATE.test(raw) || UNIT.test(raw.replace(/[./-]/g, (c) => (c === '.' ? '.' : '')))) continue;
    out.add(t);
  }
  return [...out];
}

const cache = new WeakMap();
function cardTokens(c) {
  let t = cache.get(c);
  if (!t) { t = new Set(modelTokens(`${c.title || ''} ${c.product || ''} ${c.ident || ''}`)); cache.set(c, t); }
  return t;
}

// A label word matches a notice word when they are equal, or when one extends the other and the
// shorter one has at least five characters (AT1323 on the label, AT1323-B in the notice).
function same(a, b) {
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.length >= 5 && l.startsWith(s);
}

// Recalls whose notice names one of the label's words, best first. Longer matched words weigh more.
export function rankByTokens(tokens, cards) {
  if (!tokens.length) return [];
  const out = [];
  for (const card of cards) {
    const ct = cardTokens(card);
    const hits = tokens.filter((t) => { for (const c of ct) if (same(t, c)) return true; return false; });
    if (hits.length) out.push({ card, hits, score: hits.reduce((s, h) => s + h.length, 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}
