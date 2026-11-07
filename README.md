# RecallCheck

Check whether a food package or a household product in your home is under a US safety recall.
Scan or type its barcode, take a photo, or search by name. Photos stay on your phone.

## What it does

- **Barcode.** Exact lookup of UPC/EAN codes printed in FDA food enforcement reports (2020 onward) and in
  CPSC product recalls (2018 onward). A match shows the recalled lots and dates to compare with the package.
  Notices published after the build are fetched live from openFDA and the CPSC Recalls API when you search.
- **Photo.** For items without a barcode. A DINOv2 image model (`onnx-community/dinov2-small`, 8-bit)
  runs in the browser through transformers.js and ranks CPSC recall photos by similarity. The app lists
  the five nearest recalls, says how alike each looks, and shows the notice's own description of how to
  identify the recalled product (model numbers, labels, colors). It never says an item is safe.
  Then tesseract.js reads any printed text on the same photo. If a recall notice names a model number found
  there, that recall is shown first as a model-number match.
- **Name.** Brand, product or model words, searched in the shipped CPSC records (model numbers match
  without their dashes) and live in all openFDA food enforcement reports.

## How well photo search works

Measured with `tools/eval_photo.py` on CPSC recall photos (8-bit index, as shipped). The shipped index
holds 9,845 photos from 2,826 recalls (2018 onward). The model was chosen earlier on the 2022-onward photos:

| | DINOv2-small, 2018+ (shipped) | DINOv2-small, 2022+ | CLIP ViT-B/32, 2022+ |
|---|---|---|---|
| Same recall ranked first | 53.7% | 55.5% | 49.1% |
| Same recall in the top 5 | 68.6% | 70.7% | 64.6% |
| Items not in the index called a look-alike, threshold set on recall photos | 4.6% | 4.7% | 5.0% |

In the shipped index, positive queries are 4,680 recall photos, each searched with its own photo left out of
the index. Negative queries come from 1,412 recalls removed from the index entirely, standing in for items
that were never recalled. Thresholds are set on even-numbered recalls and the tables report the odd-numbered
ones. Some recalls repeat an earlier recall of the same product, which this count scores as a miss, so the
ranking rows are lower bounds and the look-alike rows are upper bounds.

### Photos taken at home

Recall photos are clean product shots. To see what happens to a phone photo, `tools/augment_photos.py` makes
one copy of every recall photo that is cropped (55-90% of the area kept), tilted up to 12 degrees, re-lit,
shifted warmer or cooler, blurred and re-saved as a JPEG. Measured with `tools/calibrate_home.py`, which
searches with unrounded query vectors as the browser does, so the first column differs slightly from the
table above:

| Shipped index, odd-numbered recalls | Recall photos | Home-like copies |
|---|---|---|
| Same recall ranked first | 53.9% | 47.4% |
| Same recall in the top 5 | 68.5% | 63.5% |
| Items not in the index called a look-alike | 14.2% | 5.5% |

With the threshold set on clean recall photos (similarity 0.955), only 0.2% of the home-like copies that
ranked the right recall first were called a look-alike, so the label almost never appeared on a real photo.
The app now sets the threshold (0.884; "very close" at 0.935) on home-like copies of the even-numbered
recalls, at the same 5% target for items that were never recalled. Clean photos cross it more often, which
is the 14.2% in the first column. A look-alike only means "compare the model number"; photo search never
says an item matches. The copies keep the recall photo's background and framing, so real photos taken at home
will still score lower.

### Reading the label

Measured with `tools/eval_ocr.mjs` and `tools/eval_fusion.py` on 1,366 CPSC recall photos whose caption
says they show a label, model plate or tag (full-size originals, at most 1,600 px), each left out of the
photo index:

| | |
|---|---|
| Same recall first, photo match only | 27.4% |
| Same recall first, with the label read | 35.6% |
| Same recall in the top 5, photo match only / with the label read | 37.3% / 45.6% |
| Model number matches that were the right recall | 89.6% (146 of 163) |

Most misses are photos where no model number could be read (arrows, small print, low resolution). The rules
that skip dates (`092021`, `112022`) and round numbers (`30000`) were written while looking at these
results, so the last row may be a little high.

## Run it locally

Any static file server works:

```bash
python3 -m http.server 8801 --directory app
```

Then open http://localhost:8801. The camera needs `localhost` or HTTPS.

## Rebuild the data

```bash
cd tools && npm install
node fetch_raw.mjs ../data/raw 20200101 2018-01-01
node build_index.mjs ../data/raw/fda_food_enforcement_2020.json ../data/raw/cpsc_recalls_2018.json ../app/data
node fetch_images.mjs ../data/raw/cpsc_recalls_2018.json ../data/raw/img
node embed_dino.mjs onnx-community/dinov2-small ../data/raw/images_manifest.json ../data/raw/img ../data/build/dinos18
python3 eval_photo.py ../data/build/dinos18_cls ../data/build/dinos18_cls-eval.json
node eval_ocr.mjs ../data/raw/images_manifest.json ../app/data/recalls.json ../data/raw/img_label ../data/build/ocr-eval.json
node rerank_ocr.mjs ..
python3 eval_fusion.py ../data/build/dinos18_cls ../data/build/ocr-rerank.json ../data/build/fusion-eval.json
python3 augment_photos.py ../data/raw/images_manifest.json ../data/raw/img ../data/raw/img_home ../data/raw/images_manifest_home.json odd
python3 augment_photos.py ../data/raw/images_manifest.json ../data/raw/img ../data/raw/img_home_even ../data/raw/images_manifest_home_even.json even
node embed_dino.mjs onnx-community/dinov2-small ../data/raw/images_manifest_home.json ../data/raw/img_home ../data/build/dinohome
node embed_dino.mjs onnx-community/dinov2-small ../data/raw/images_manifest_home_even.json ../data/raw/img_home_even ../data/build/dinohome_even
python3 calibrate_home.py ../data/build/dinos18_cls ../data/build/dinohome_even_cls ../data/raw/images_manifest_home_even.json ../data/build/dinohome_cls ../data/raw/images_manifest_home.json ../data/build/dinos18_cls-eval.json ../data/build/calibrate-home.json
python3 pack_photo.py ../data/build/dinos18_cls ../data/build/dinos18_cls-eval.json ../app/data ../data/build/fusion-eval.json ../data/build/calibrate-home.json
node --test test_upc.mjs test_labeltext.mjs
```

`embed_dino.mjs` downloads the model into the transformers.js cache. Copy `config.json`,
`preprocessor_config.json` and `onnx/model_quantized.onnx` from
`tools/node_modules/@huggingface/transformers/.cache/onnx-community/dinov2-small/` into
`app/models/onnx-community/dinov2-small/` so the page loads the same weights offline.
`embed.mjs` is the CLIP version used for the comparison above. `rerank_ocr.mjs` re-scores the OCR words
saved in `ocr-eval.json` with the current `app/js/labeltext.js` rules, so rule changes need no new OCR run.
The English language data in `app/models/tessdata/` is the `eng.traineddata` that tesseract.js downloads
(`4.0.0_best_int`), gzipped.

## Data sources and limits

- U.S. FDA food enforcement reports via [openFDA](https://open.fda.gov/apis/food/enforcement/).
- U.S. CPSC [Recalls API](https://www.cpsc.gov/Recalls/CPSC-Recalls-Application-Program-Interface-API-Information).
- A barcode match lists the recalled lots and dates; compare them with your package.
- Most household product recalls list no barcode, so a barcode miss means little for those items.
- Not affiliated with FDA or CPSC. Always read the official notice.

## Third-party code and models

- transformers.js (Apache-2.0) with ONNX Runtime Web (MIT), vendored in `app/vendor/transformers/`.
- zxing-wasm (MIT), built on zxing-cpp (Apache-2.0), vendored in `app/vendor/zxing/`.
- tesseract.js and tesseract.js-core (Apache-2.0), vendored in `app/vendor/tesseract/`.
- DINOv2-small weights (Apache-2.0, Meta; ONNX export by onnx-community) and Tesseract English LSTM data
  (Apache-2.0, tessdata_best), in `app/models/`.

## License

The RecallCheck code in this repository is under the MIT License (`LICENSE`). The vendored libraries and model
files above keep their own licences, and the recall records are U.S. government data from FDA and CPSC.
Demo photos and their sources are listed in `demo/photos/SOURCES.json`.
