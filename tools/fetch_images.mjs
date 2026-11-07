// Download CPSC recall photos and store each as a 320px-max JPEG.
// Usage: node fetch_images.mjs <recalls.json> <out_dir>
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const [recallsPath, outDir] = process.argv.slice(2);
const recalls = JSON.parse(await fs.readFile(recallsPath, 'utf8'));
await fs.mkdir(outDir, { recursive: true });

const jobs = [];
for (const r of recalls) {
  (r.Images || []).forEach((img, i) => {
    if (!img.URL || !img.URL.startsWith('https://')) return;
    jobs.push({ recallId: r.RecallID, index: i, url: img.URL, caption: img.Caption || '' });
  });
}

const manifest = [];
let done = 0, failed = 0;
async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    const name = `${job.recallId}_${job.index}.jpg`;
    const file = path.join(outDir, name);
    try {
      await fs.access(file);
      manifest.push({ ...job, file: name });
      done++;
      continue;
    } catch {}
    try {
      const res = await fetch(job.url, { headers: { 'User-Agent': 'recallcheck-student-build/0.1' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const out = await sharp(buf, { animated: false })
        .flatten({ background: '#ffffff' })
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      await fs.writeFile(file, out);
      manifest.push({ ...job, file: name, sha256: crypto.createHash('sha256').update(out).digest('hex') });
      done++;
    } catch (e) {
      failed++;
      manifest.push({ ...job, file: null, error: String(e.message || e).slice(0, 120) });
    }
    if ((done + failed) % 250 === 0) console.log(`progress ${done + failed} ok=${done} failed=${failed}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
manifest.sort((a, b) => a.recallId - b.recallId || a.index - b.index);
await fs.writeFile(path.join(outDir, '..', 'images_manifest.json'), JSON.stringify(manifest));
console.log(`finished ok=${done} failed=${failed}`);
