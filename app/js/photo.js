// Photo search on the device: a DINOv2 image embedding of the user's photo, ranked against recall photos.
// The model files and the photo index are served from this site; nothing about the photo leaves the phone.

const MODEL_ID = 'onnx-community/dinov2-small';
const DTYPE = 'q8'; // must match tools/embed_dino.mjs (CLS token, L2-normalised)

let rowsMeta = null; // { dim, rows: [recallId], thresholds }
let matrix = null; // Int8Array N x dim
let norms = null; // Float32Array N
let modelPromise = null;

export async function loadPhotoIndex() {
  if (matrix) return rowsMeta;
  const [m, bin] = await Promise.all([
    fetch('data/photo-index.json').then((r) => { if (!r.ok) throw new Error('photo index'); return r.json(); }),
    fetch('data/photo-index.bin').then((r) => { if (!r.ok) throw new Error('photo index'); return r.arrayBuffer(); }),
  ]);
  rowsMeta = m;
  matrix = new Int8Array(bin);
  const n = m.rows.length, d = m.dim;
  norms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < d; k++) { const v = matrix[i * d + k]; s += v * v; }
    norms[i] = Math.sqrt(s) || 1;
  }
  return rowsMeta;
}

export function loadModel(onProgress) {
  if (!modelPromise) {
    modelPromise = (async () => {
      const t = await import('../vendor/transformers/transformers.min.js');
      t.env.allowRemoteModels = false;
      t.env.allowLocalModels = true;
      t.env.localModelPath = new URL('../models/', import.meta.url).href;
      t.env.backends.onnx.wasm.wasmPaths = new URL('../vendor/transformers/', import.meta.url).href;
      t.env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const files = {};
      const progress_callback = (p) => {
        if (p.status === 'progress' && p.total) {
          files[p.file] = [p.loaded, p.total];
          const loaded = Object.values(files).reduce((a, [l]) => a + l, 0);
          const total = Object.values(files).reduce((a, [, tt]) => a + tt, 0);
          onProgress?.(loaded / total);
        }
      };
      const processor = await t.AutoProcessor.from_pretrained(MODEL_ID, { progress_callback });
      const model = await t.AutoModel.from_pretrained(MODEL_ID, { dtype: DTYPE, device: 'wasm', progress_callback });
      return { t, processor, model };
    })();
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

export async function embedPhoto(file, onProgress) {
  const { t, processor, model } = await loadModel(onProgress);
  // fromBlob avoids fetch(blob:), which the page CSP does not allow.
  {
    const image = await t.RawImage.fromBlob(file);
    const inputs = await processor(image);
    const { last_hidden_state } = await model(inputs);
    const dim = last_hidden_state.dims[2];
    const v = Float32Array.from(last_hidden_state.data.subarray(0, dim)); // CLS token
    let s = 0;
    for (const x of v) s += x * x;
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= s;
    return v;
  }
}

// Best photo per recall, highest similarity first.
export function rankRecalls(q, limit = 5) {
  const n = rowsMeta.rows.length, d = rowsMeta.dim;
  const best = new Map();
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * d;
    for (let k = 0; k < d; k++) s += q[k] * matrix[o + k];
    s /= norms[i];
    const [rid, img] = rowsMeta.rows[i];
    const prev = best.get(rid);
    if (!prev || s > prev.sim) best.set(rid, { rid, img, sim: s });
  }
  return [...best.values()].sort((a, b) => b.sim - a.sim).slice(0, limit);
}

export function thresholds() { return rowsMeta?.thresholds; }
