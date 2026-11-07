// Barcode reading: the browser's BarcodeDetector when it supports retail formats, else zxing-wasm.
const RETAIL = ['ean_13', 'upc_a', 'upc_e', 'ean_8'];
const ZX_FORMATS = ['EAN-13', 'UPC-A', 'UPC-E', 'EAN-8'];

let detectorPromise = null;
async function getDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      if ('BarcodeDetector' in window) {
        try {
          const supported = await window.BarcodeDetector.getSupportedFormats();
          const formats = RETAIL.filter((f) => supported.includes(f));
          if (formats.length >= 2) {
            const det = new window.BarcodeDetector({ formats });
            return async (source) => (await det.detect(source)).map((b) => ({ text: b.rawValue, format: b.format }));
          }
        } catch { /* fall through to zxing */ }
      }
      const zx = await import('../vendor/zxing/reader/index.js');
      zx.setZXingModuleOverrides({ locateFile: (p) => new URL(`../vendor/zxing/${p}`, import.meta.url).href });
      return async (source) => {
        const data = source instanceof ImageData ? source : toImageData(source);
        const found = await zx.readBarcodes(data, { formats: ZX_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
        return found.filter((b) => b.isValid).map((b) => ({ text: b.text, format: b.format }));
      };
    })();
  }
  return detectorPromise;
}

const canvas = document.createElement('canvas');
function toImageData(source) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, 1280 / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function readFromFile(file) {
  const detect = await getDetector();
  const bitmap = await createImageBitmap(file);
  try {
    let found = await detect(bitmap).catch(() => []);
    if (!found.length) found = await detect(toImageData(bitmap));
    return found[0] || null;
  } finally {
    bitmap.close?.();
  }
}

let stream = null;
let running = false;

export async function startCamera(video, onCode) {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const detect = await getDetector();
  running = true;
  const tick = async () => {
    if (!running) return;
    try {
      if (video.readyState >= 2) {
        const found = await detect(video);
        if (found.length && running) {
          stopCamera(video);
          onCode(found[0]);
          return;
        }
      }
    } catch { /* keep scanning */ }
    setTimeout(tick, 250);
  };
  tick();
}

export function stopCamera(video) {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
}
