"""Devpost gallery images (3:2, 1500x1000) from the captured phone frames. Writes demo/gallery/*.png."""
import json
from pathlib import Path
from PIL import Image, ImageDraw
from build_video import FR, INK, INK2, PAPER, font, wrap

D = Path(__file__).resolve().parent
OUT = D / "gallery"
W, H = 1500, 1000
PH = 900
PW = round(PH * 824 / 1830)
PX, PY = 150, 50
ITEMS = [  # file, frame, heading, caption shown on the image, Devpost caption (<= 140 characters)
    ("01-recallcheck.png", ("s1_barcode", 0), "RecallCheck",
     "Is something in your home under a US safety recall? Check by barcode, photo or name.",
     "RecallCheck: check a food package or household product against US recall records by barcode, photo or name."),
    ("02-barcode.png", ("s1_barcode", 40), "Barcode",
     "An exact match against barcodes printed in FDA and CPSC recall records, with the lots and dates to compare.",
     "A barcode read from a saved photo matches five FDA recall reports. The newest shows the lots and dates to compare."),
    ("03-photo.png", ("s2_photo", 80), "Photo",
     "DINOv2 compares your photo with 9,845 CPSC recall photos in the browser. It never says an item is safe.",
     "Photo search runs on the phone. This kettle has no close look-alike, so the page lists the five nearest recalls."),
    ("04-label.png", ("s3_label", 55), "Label",
     "tesseract.js reads the model number on the phone. A recall that names it goes first.",
     "The label reader finds XY-15302, a model number a glue gun recall names, although the image match found nothing close."),
    ("05-measured.png", ("s5_about", 70), "Measured",
     "Tested on recall photos left out of the index, and on copies altered to look like phone photos.",
     "Held-out CPSC photos: right recall first 54% (47% on phone-like copies); reading the label lifts first place from 27% to 36%."),
]


def make(path, frame, heading, caption, cover):
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([PX - 14, PY - 14, PX + PW + 14, PY + PH + 14], radius=40, fill=INK)
    shot = Image.open(FR / frame[0] / f"f{frame[1]:04d}.jpg").convert("RGB").resize((PW, PH), Image.LANCZOS)
    im.paste(shot, (PX, PY))
    x = 690
    if cover:
        d.text((x - 6, 300), heading, font=font(116, "Heavy"), fill=INK)
        d.rectangle([x, 450, x + 140, 459], fill=INK)
        y, f, step = 500, font(44), 62
    else:
        d.text((x, 270), "RecallCheck", font=font(32, "Semibold"), fill=INK2)
        d.text((x - 4, 314), heading, font=font(96, "Heavy"), fill=INK)
        d.rectangle([x, 446, x + 110, 454], fill=INK)
        y, f, step = 492, font(40), 58
    for ln in wrap(d, caption, f, 700):
        d.text((x, y), ln, font=f, fill=INK if cover else INK2)
        y += step
    im.save(path)


def main():
    OUT.mkdir(exist_ok=True)
    caps = {}
    for k, (name, frame, heading, caption, devpost) in enumerate(ITEMS):
        assert len(devpost) <= 140, (name, len(devpost))
        make(OUT / name, frame, heading, caption, cover=(k == 0))
        caps[name] = devpost
    (OUT / "captions.json").write_text(json.dumps(caps, indent=1))
    print(json.dumps({n: len(c) for n, c in caps.items()}))


if __name__ == "__main__":
    main()
