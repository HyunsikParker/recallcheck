"""Pack embeddings for the browser and write the measured-quality summary the page shows.

Usage: python3 pack_photo.py <prefix> <eval.json> <app_data_dir> [fusion-eval.json] [calibrate-home.json]
Writes photo-index.bin (int8, N x dim), photo-index.json (rows + thresholds), photo-quality.json.
With calibrate-home.json (tools/calibrate_home.py) the look-alike thresholds are the ones set on home-like copies of the
even-id photos, and the quality summary reports recall photos and home-like copies side by side at those thresholds.
"""
import json
import sys

import numpy as np

prefix, eval_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
meta = json.load(open(prefix + ".json"))
ev = json.load(open(eval_path))["int8_shipped"]
X = np.fromfile(prefix + ".f32", dtype=np.float32).reshape(len(meta["rows"]), meta["dim"])
Q = np.clip(np.round(X * 127), -127, 127).astype(np.int8)
Q.tofile(f"{out_dir}/photo-index.bin")

th = ev["thresholds_from_even_recall_ids"]
home = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else None
if home:
    th = home["home_thresholds_from_even_ids"]
json.dump({
    "model": meta["model"], "dtype": meta["dtype"], "dim": meta["dim"],
    "rows": [[r["recallId"], r["index"]] for r in meta["rows"]],
    "thresholds": {"close": th["close"], "strong": th["strong"]},
}, open(f"{out_dir}/photo-index.json", "w"), separators=(",", ":"))

t = ev["test_odd_recall_ids"]
label = None
if len(sys.argv) > 4:
    f = json.load(open(sys.argv[4]))
    label = {
        "image_top1": f["image_top1"], "fused_top1": f["fused_top1"],
        "text_precision": round(f["text_match_right_first"] / f["text_match"], 4),
        "queries": f["label_photo_queries"],
        "note": (f"Measured on {f['label_photo_queries']:,} CPSC recall photos of labels, model plates and tags, each "
                 f"left out of the photo index. A model number matched a notice on {f['text_match']} of them. The rules "
                 "that skip dates and round numbers were written while looking at these photos, so the last number may be a little high."),
    }
if home:
    c, h = home["odd_clean@home_thresholds"], home["odd_home_like@home_thresholds"]
    quality = {
        "top1": c["top1"], "top5": c["top5"], "false_close": c["false_lookalike"],
        "home": {"top1": h["top1"], "top5": h["top5"], "false_close": h["false_lookalike"]},
        "queries": c["queries"], "held_out_recalls": c["held_out_recalls"], "label": label,
        "note": (f"Measured on {c['queries']:,} recall photos used as queries, with the photo itself left out of the index, "
                 f"and on {c['held_out_recalls']:,} recalls removed entirely to stand in for items that were never recalled. "
                 "Home-like copies are the same photos cropped, tilted, re-lit, blurred and re-saved, as a phone photo "
                 "might be. The look-alike threshold was set on home-like copies of the other half of the recalls, so "
                 "photos as clean as a recall notice's are called look-alikes more often. Some recalls repeat an earlier "
                 "recall of the same product, which this count treats as a miss. Real photos taken at home differ more "
                 "than these copies, so expect lower numbers in real use."),
    }
else:
    quality = {
        "top1": t["top1"], "top5": t["top5"], "false_close": t["false_close"],
        "queries": t["queries"], "held_out_recalls": t["held_out_recalls"], "label": label,
        "note": (f"Measured on {t['queries']:,} recall photos used as queries, with the photo itself left out of "
                 f"the index, and on {t['held_out_recalls']:,} recalls removed entirely to stand in for items that "
                 "were never recalled. The look-alike threshold was set on the other half of the recalls. Some recalls "
                 "repeat an earlier recall of the same product, which this count treats as a miss, so the first two "
                 "numbers are lower bounds and the third is an upper bound. Recall photos are cleaner than photos taken at home, so expect lower "
                 "numbers in real use."),
    }
json.dump(quality, open(f"{out_dir}/photo-quality.json", "w"), indent=1)
print("packed", Q.shape, th, quality.get("home"), t["top1"])
