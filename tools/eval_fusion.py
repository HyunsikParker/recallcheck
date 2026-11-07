"""Label photos: image search alone vs. image search with label words read by OCR ranked first.

Usage: python3 eval_fusion.py <embed_prefix> <ocr-rerank.json> <out.json>
Image ranking leaves the query photo out of the index (other photos of the same recall stay), as in
eval_photo.py. Fused ranking: recalls whose notice names a word read from the label come first (by
text score), then the image ranking.
"""
import json
import sys

import numpy as np

prefix, ocr_path, out_path = sys.argv[1:4]
meta = json.load(open(prefix + ".json"))
rows = meta["rows"]
X = np.fromfile(prefix + ".f32", dtype=np.float32).reshape(len(rows), meta["dim"])
X = np.clip(np.round(X * 127), -127, 127).astype(np.float32) / 127  # as shipped (int8)
rid = np.array([str(r["recallId"]) for r in rows])
pos = {r["file"]: i for i, r in enumerate(rows)}
ocr = json.load(open(ocr_path))


def image_rank(i, k=5):
    s = X @ X[i]
    s[i] = -9
    order = np.argsort(-s)
    seen, out = set(), []
    for j in order:
        if rid[j] not in seen:
            seen.add(rid[j]); out.append(rid[j])
            if len(out) == k:
                break
    return out


res = {"image": [0, 0], "fused": [0, 0]}
n = text_any = text_right = 0
for q in ocr:
    i = pos.get(q["file"])
    if i is None:
        continue
    n += 1
    img = image_rank(i)
    text = [t["rid"] for t in q["ranked"]]
    if text:
        text_any += 1
        text_right += text[0] == q["recallId"]
    fused = (text + [r for r in img if r not in text])[:5]
    for name, ranking in (("image", img), ("fused", fused)):
        res[name][0] += ranking[0] == q["recallId"]
        res[name][1] += q["recallId"] in ranking
summary = {"label_photo_queries": n, "text_match": text_any, "text_match_right_first": text_right,
           **{f"{k}_top1": round(v[0] / n, 4) for k, v in res.items()},
           **{f"{k}_top5": round(v[1] / n, 4) for k, v in res.items()}}
print(summary)
json.dump(summary, open(out_path, "w"), indent=1)
