// Re-score the OCR words saved by eval_ocr.mjs with the current app/js/labeltext.js rules (no new OCR).
// Usage: node rerank_ocr.mjs <project_root>   (reads data/build/ocr-eval.json, writes data/build/ocr-rerank.json)
import fs from 'node:fs/promises';
const root = process.argv[2];
const { modelTokens, rankByTokens } = await import(`${root}/app/js/labeltext.js`);
const d = JSON.parse(await fs.readFile(`${root}/data/build/ocr-eval.json`, 'utf8'));
const recalls = JSON.parse(await fs.readFile(`${root}/app/data/recalls.json`, 'utf8'));
const cards = Object.entries(recalls).filter(([k]) => k.startsWith('cpsc:')).map(([key, c]) => ({ key, ...c }));
let right = 0, wrong = 0, any = 0; const out = [];
for (const r of d.rows) {
  if (r.missing) continue;
  const tokens = modelTokens(r.tokens.join(' '));
  const ranked = rankByTokens(tokens, cards).slice(0, 5).map((x) => ({ rid: String(x.card.rid), score: x.score, hits: x.hits }));
  if (ranked.length) { any++; if (ranked[0].rid === String(r.recallId)) right++; else wrong++; }
  out.push({ recallId: String(r.recallId), file: r.file, ranked });
}
console.log({ rows: out.length, any, right, wrong });
await fs.writeFile(`${root}/data/build/ocr-rerank.json`, JSON.stringify(out));
