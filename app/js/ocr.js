// Read printed text (model numbers on a label) from a photo, on the device, with tesseract.js.
// Everything loads from this site: the worker, the wasm core and the English LSTM data.
const base = new URL('../', import.meta.url);
let workerPromise = null;
let progressCb = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { default: Tesseract } = await import('../vendor/tesseract/tesseract.esm.min.js');
      return Tesseract.createWorker('eng', 1, {
        workerPath: new URL('vendor/tesseract/worker.min.js', base).href,
        corePath: new URL('vendor/tesseract/', base).href,
        langPath: new URL('models/tessdata', base).href,
        workerBlobURL: false,
        logger: (m) => { if (progressCb && typeof m.progress === 'number') progressCb(m.status, m.progress); },
      });
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// Phone photos are 12 MP; label text stays readable at 2000 px on the long side and OCR is much faster.
async function shrink(file, maxSide = 2000) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

export async function readText(file, onProgress) {
  progressCb = onProgress || null;
  const [worker, image] = await Promise.all([getWorker(), shrink(file)]);
  const { data } = await worker.recognize(image);
  progressCb = null;
  return data.text || '';
}
