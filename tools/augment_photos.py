"""Make "taken at home" versions of the test-half recall photos for a robustness check of photo search.

Each test photo (odd recall id) gets one degraded copy: an off-centre crop that keeps 55-90% of the area, a tilt of up
to 12 degrees, a brightness, contrast and colour-temperature shift, a little blur and a JPEG re-save. The settings come
from a seed hashed from the file name, so the set is the same on every run.

Usage: python3 augment_photos.py <images_manifest.json> <img_dir> <out_dir> <out_manifest.json> [odd|even]
(odd = the test half, the default; even = the half used to set thresholds)
"""
import hashlib, json, random, sys
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter

manifest_path, img_dir, out_dir, out_manifest = sys.argv[1:5]
parity = 1 if (sys.argv[5] if len(sys.argv) > 5 else "odd") == "odd" else 0
img_dir, out_dir = Path(img_dir), Path(out_dir)
out_dir.mkdir(parents=True, exist_ok=True)
rows = [m for m in json.load(open(manifest_path)) if m.get("file") and m["recallId"] % 2 == parity]


def rng_for(name):
    return random.Random(int.from_bytes(hashlib.sha256(name.encode()).digest()[:8], "big"))


def degrade(im, r):
    im = im.convert("RGB")
    w, h = im.size
    # tilt first, filled with the photo's mean colour, then crop inside the frame
    mean = tuple(int(v) for v in im.resize((1, 1), Image.BILINEAR).getpixel((0, 0)))
    im = im.rotate(r.uniform(-12, 12), resample=Image.BICUBIC, expand=False, fillcolor=mean)
    keep = r.uniform(0.55, 0.90)
    cw, ch = int(w * keep ** 0.5 * r.uniform(0.9, 1.1)), int(h * keep ** 0.5 * r.uniform(0.9, 1.1))
    cw, ch = min(cw, w), min(ch, h)
    x0, y0 = r.randint(0, w - cw), r.randint(0, h - ch)
    im = im.crop((x0, y0, x0 + cw, y0 + ch))
    im = ImageEnhance.Brightness(im).enhance(r.uniform(0.7, 1.3))
    im = ImageEnhance.Contrast(im).enhance(r.uniform(0.75, 1.25))
    warm = r.uniform(-0.12, 0.12)  # colour temperature: scale red up and blue down, or the reverse
    rch, gch, bch = im.split()
    rch = rch.point(lambda v: max(0, min(255, int(v * (1 + warm)))))
    bch = bch.point(lambda v: max(0, min(255, int(v * (1 - warm)))))
    im = Image.merge("RGB", (rch, gch, bch))
    im = im.filter(ImageFilter.GaussianBlur(r.uniform(0.0, 1.2)))
    return im, r.randint(55, 85)


out_rows = []
for m in rows:
    r = rng_for(m["file"])
    im, q = degrade(Image.open(img_dir / m["file"]), r)
    name = Path(m["file"]).stem + "_home.jpg"
    im.save(out_dir / name, quality=q)
    out_rows.append({**m, "file": name, "source_file": m["file"]})
json.dump(out_rows, open(out_manifest, "w"))
print(f"degraded {len(out_rows)} photos into {out_dir}")
