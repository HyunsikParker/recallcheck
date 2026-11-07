// Does reading the label help? OCR the CPSC recall photos whose caption says they show a label,
// model plate or serial number, then rank recalls by the model-like words found in each notice's text.
// Usage: node eval_ocr.mjs <images_manifest.json> <recalls.json> <full_img_dir> <out.json>
// Downloads the full-size originals (www.cpsc.gov only) into full_img_dir, resized to at most
// 1600 px on the long side, since a phone photo of a label is larger than the 320 px index copies.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createScheduler, createWorker } from 'tesseract.js';
import { modelTokens, rankByTokens } from '../app/js/labeltext.js';

const [manifestPath, recallsPath, imgDir, outPath] = process.argv.slice(2);
const LABEL = /label|model number|model plate|serial|sticker|date code|tag\b|hangtag|rating plate/i;
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')).filter((m) => m.file && LABEL.test(m.caption || ''));
const recalls = JSON.parse(await fs.readFile(recallsPath, 'utf8'));
const cards = Object.entries(recalls).filter(([k]) => k.startsWith('cpsc:')).map(([key, c]) => ({ key, ...c }));
await fs.mkdir(imgDir, { recursive: true });

async function fetchOne(m) {
  const out = path.join(imgDir, m.file.replace(/\.jpg$/, '.png'));
  try { await fs.access(out); return out; } catch {}
  if (!/^https:\/\/(www\.)?cpsc\.gov\//.test(m.url || '')) return null;
  const res = await fetch(m.url, { headers: { 'User-Agent': 'RecallCheck-eval/1.0' } });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  await sharp(buf).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).png().toFile(out);
  return out;
}

const files = [];
for (let i = 0; i < manifest.length; i += 4) {
  const got = await Promise.all(manifest.slice(i, i + 4).map((m) => fetchOne(m).catch(() => null)));
  got.forEach((f, j) => files.push([manifest[i + j], f]));
  if (i % 200 === 0) console.log(`fetched ${i + 4}/${manifest.length}`);
}

const scheduler = createScheduler();
for (let w = 0; w < 4; w++) scheduler.addWorker(await createWorker('eng'));
const t0 = Date.now();
const rows = await Promise.all(files.map(async ([m, f], i) => {
  if (!f) return { recallId: m.recallId, file: m.file, missing: true };
  const { data } = await scheduler.addJob('recognize', f);
  const tokens = modelTokens(data.text);
  const ranked = rankByTokens(tokens, cards).slice(0, 5).map((r) => ({ rid: r.card.rid, score: r.score, hits: r.hits }));
  if (i % 100 === 0) console.log(`ocr ${i}/${files.length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return { recallId: m.recallId, file: m.file, caption: m.caption, tokens, ranked };
}));
await scheduler.terminate();

const scored = rows.filter((r) => !r.missing);
const own = (r) => recalls[`cpsc:${r.recallId}`];
const answerable = scored.filter((r) => modelTokens(own(r)?.ident || '').length);
const top1 = scored.filter((r) => r.ranked[0]?.rid === r.recallId).length;
const anyHit = scored.filter((r) => r.ranked.length).length;
const wrongFirst = scored.filter((r) => r.ranked.length && r.ranked[0].rid !== r.recallId).length;
const summary = {
  label_photos: manifest.length, ocr_run: scored.length,
  notices_with_model_words: answerable.length,
  any_text_match: anyHit, right_recall_first: top1, wrong_recall_first: wrongFirst,
  seconds: Math.round((Date.now() - t0) / 1000),
};
console.log(summary);
await fs.writeFile(outPath, JSON.stringify({ summary, rows }, null, 1));
