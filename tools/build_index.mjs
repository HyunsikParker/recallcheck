// Build the shipped recall data: a UPC index (FDA food + CPSC) and CPSC recall cards.
// Usage: node build_index.mjs <fda.json> <cpsc.json> <out_dir>
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractUpcs, normaliseScanned } from '../app/js/upc.js';

const [fdaPath, cpscPath, outDir] = process.argv.slice(2);
const fda = JSON.parse(await fs.readFile(fdaPath, 'utf8'));
const cpsc = JSON.parse(await fs.readFile(cpscPath, 'utf8'));
await fs.mkdir(outDir, { recursive: true });

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
const upcIndex = {}; // gtin14 -> [recall key]
const recalls = {}; // key -> card
let fdaWithUpc = 0, fdaDerivedOnly = 0;

for (const r of fda) {
  const key = `fda:${r.recall_number}`;
  const upcs = extractUpcs(`${r.product_description || ''} ${r.code_info || ''}`);
  if (!upcs.length) continue;
  fdaWithUpc++;
  if (upcs.every((u) => u.derived)) fdaDerivedOnly++;
  recalls[key] = {
    src: 'FDA',
    id: r.recall_number,
    date: r.report_date, // YYYYMMDD
    firm: clip(r.recalling_firm, 80),
    product: clip(r.product_description, 240),
    reason: clip(r.reason_for_recall, 240),
    cls: r.classification,
    status: r.status,
    area: clip(r.distribution_pattern, 120),
    codes: clip(r.code_info, 320),
  };
  for (const u of upcs) (upcIndex[u.gtin14] ||= []).push(key);
}

let cpscWithUpc = 0;
const cards = [];
for (const r of cpsc) {
  const key = `cpsc:${r.RecallID}`;
  const card = {
    src: 'CPSC',
    id: r.RecallNumber,
    rid: r.RecallID,
    date: (r.RecallDate || '').slice(0, 10),
    title: clip(r.Title, 200),
    product: clip((r.Products || []).map((p) => p.Name).filter(Boolean).join('; '), 200),
    // the notice's own description: model numbers, labels and colours that identify the product
    ident: clipLines(r.Description, 1200),
    hazard: clip((r.Hazards || []).map((h) => h.Name).join(' '), 260),
    remedy: clip((r.Remedies || []).map((h) => h.Name).join(' '), 260),
    units: clip((r.Products || []).map((p) => p.NumberOfUnits).filter(Boolean).join('; '), 80),
    sold: clip((r.Retailers || []).map((x) => x.Name).join('; '), 160),
    url: /^https:\/\/(www\.)?cpsc\.gov\//.test(r.URL || '') ? r.URL : null,
    // photo URLs by index, as embedded; only www.cpsc.gov / cpsc.gov hosts are kept (CSP img-src)
    imgs: (r.Images || []).map((i) => (/^https:\/\/(www\.)?cpsc\.gov\//.test(i.URL || '') ? i.URL.replace('https://cpsc.gov/', 'https://www.cpsc.gov/') : null)),
  };
  recalls[key] = card;
  cards.push(key);
  const upcs = (r.ProductUPCs || []).map((u) => normaliseScanned(u.UPC)).filter(Boolean);
  if (upcs.length) cpscWithUpc++;
  for (const u of upcs) (upcIndex[u] ||= []).push(key);
}

const meta = {
  built_at_utc: new Date().toISOString(),
  fda_reports_read: fda.length,
  fda_reports_with_upc: fdaWithUpc,
  fda_reports_only_derived_upc: fdaDerivedOnly,
  fda_earliest_report_date: fda.reduce((m, r) => (!m || r.report_date < m ? r.report_date : m), ''),
  fda_latest_report_date: fda.reduce((m, r) => (r.report_date > m ? r.report_date : m), ''),
  cpsc_recalls_read: cpsc.length,
  cpsc_recalls_with_upc: cpscWithUpc,
  cpsc_earliest_recall_date: cpsc.reduce((m, r) => (!m || r.RecallDate < m ? r.RecallDate : m), '').slice(0, 10),
  cpsc_latest_recall_date: cpsc.reduce((m, r) => (r.RecallDate > m ? r.RecallDate : m), '').slice(0, 10),
  distinct_upcs: Object.keys(upcIndex).length,
};
await fs.writeFile(path.join(outDir, 'upc-index.json'), JSON.stringify({ meta, upc: upcIndex }));
await fs.writeFile(path.join(outDir, 'recalls.json'), JSON.stringify(recalls));
console.log(JSON.stringify(meta, null, 1));
