// Render a UPC-A barcode for a code printed in a recall notice, for the demo video and screenshots.
// Usage: node make_demo_barcode.mjs <12-digit UPC> <out.png>
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { writeBarcode } from 'zxing-wasm/writer';

const [upc, out] = process.argv.slice(2);
const res = await writeBarcode(upc, { format: 'UPC-A', scale: 4, addQuietZones: true, addHRT: true });
if (res.error) throw new Error(res.error);
const svg = res.svg;
await sharp(Buffer.from(svg)).flatten({ background: '#ffffff' }).extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#ffffff' }).png().toFile(out);
console.log('wrote', out);
