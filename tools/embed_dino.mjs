// Embed recall photos with DINOv2 (same model id and dtype the browser loads).
// Usage: node embed_dino.mjs <model_id> <images_manifest.json> <img_dir> <out_prefix>
// Writes <out_prefix>_cls.{f32,json} (CLS token) and <out_prefix>_cat.{f32,json} (CLS + mean patch token).
import fs from 'node:fs/promises';
import path from 'node:path';
import { AutoProcessor, AutoModel, RawImage, env } from '@huggingface/transformers';

const [modelId, manifestPath, imgDir, outPrefix] = process.argv.slice(2);
const DTYPE = 'q8';
env.allowLocalModels = false;
const processor = await AutoProcessor.from_pretrained(modelId);
const model = await AutoModel.from_pretrained(modelId, { dtype: DTYPE });

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')).filter((m) => m.file);
let D = 0, cls = null, cat = null;
const rows = [];
const t0 = Date.now();
const BATCH = 16;
const norm = (arr, off, n) => { let s = 0; for (let k = 0; k < n; k++) s += arr[off + k] ** 2; return Math.sqrt(s) || 1; };
for (let s = 0; s < manifest.length; s += BATCH) {
  const chunk = manifest.slice(s, s + BATCH);
  const images = await Promise.all(chunk.map((m) => RawImage.read(path.join(imgDir, m.file))));
  const inputs = await processor(images);
  const out = await model(inputs);
  const h = out.last_hidden_state; // [B, T, D]
  const [B, T, d] = h.dims;
  if (!D) { D = d; cls = new Float32Array(manifest.length * D); cat = new Float32Array(manifest.length * 2 * D); }
  const data = h.data;
  for (let j = 0; j < B; j++) {
    const base = j * T * D;
    const c = new Float32Array(D), mp = new Float32Array(D);
    for (let k = 0; k < D; k++) c[k] = data[base + k];
    for (let t = 1; t < T; t++) for (let k = 0; k < D; k++) mp[k] += data[base + t * D + k] / (T - 1);
    const nc = norm(c, 0, D), nm = norm(mp, 0, D);
    const row = s + j;
    for (let k = 0; k < D; k++) cls[row * D + k] = c[k] / nc;
    // concatenate the two unit vectors, then rescale so the whole vector has unit length
    for (let k = 0; k < D; k++) { cat[row * 2 * D + k] = c[k] / nc / Math.SQRT2; cat[row * 2 * D + D + k] = mp[k] / nm / Math.SQRT2; }
    const m = chunk[j];
    rows.push({ recallId: m.recallId, index: m.index, file: m.file, caption: m.caption });
  }
  if ((s / BATCH) % 50 === 0) console.log(`embedded ${s + chunk.length}/${manifest.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await fs.writeFile(`${outPrefix}_cls.f32`, Buffer.from(cls.buffer));
await fs.writeFile(`${outPrefix}_cls.json`, JSON.stringify({ model: modelId, dtype: DTYPE, dim: D, pool: 'cls', rows }));
await fs.writeFile(`${outPrefix}_cat.f32`, Buffer.from(cat.buffer));
await fs.writeFile(`${outPrefix}_cat.json`, JSON.stringify({ model: modelId, dtype: DTYPE, dim: 2 * D, pool: 'cls+meanpatch', rows }));
console.log(`done ${rows.length} rows dim ${D}`);
