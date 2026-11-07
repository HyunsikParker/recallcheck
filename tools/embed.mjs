// Embed recall photos with the same CLIP vision model and dtype the browser loads.
// Usage: node embed.mjs <images_manifest.json> <img_dir> <out_prefix>
// Writes <out_prefix>.f32 (N x 512 float32, L2-normalised) and <out_prefix>.json (row metadata).
import fs from 'node:fs/promises';
import path from 'node:path';
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from '@huggingface/transformers';

export const MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const DTYPE = 'q8';

const [manifestPath, imgDir, outPrefix] = process.argv.slice(2);
env.allowLocalModels = false;
const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { dtype: DTYPE });

const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')).filter((m) => m.file);
const dim = 512;
const out = new Float32Array(manifest.length * dim);
const rows = [];
const t0 = Date.now();
const BATCH = 16;
for (let s = 0; s < manifest.length; s += BATCH) {
  const chunk = manifest.slice(s, s + BATCH);
  const images = await Promise.all(chunk.map((m) => RawImage.read(path.join(imgDir, m.file))));
  const inputs = await processor(images);
  const { image_embeds } = await model(inputs);
  const data = image_embeds.data;
  chunk.forEach((m, j) => {
    let norm = 0;
    for (let k = 0; k < dim; k++) norm += data[j * dim + k] ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dim; k++) out[(s + j) * dim + k] = data[j * dim + k] / norm;
    rows.push({ recallId: m.recallId, index: m.index, file: m.file, caption: m.caption });
  });
  if ((s / BATCH) % 25 === 0) console.log(`embedded ${s + chunk.length}/${manifest.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
await fs.writeFile(`${outPrefix}.f32`, Buffer.from(out.buffer));
await fs.writeFile(`${outPrefix}.json`, JSON.stringify({ model: MODEL_ID, dtype: DTYPE, dim, rows }));
console.log(`done ${rows.length} rows`);
