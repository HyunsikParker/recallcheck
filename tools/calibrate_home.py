"""Set the look-alike thresholds on home-like photos of the even recall ids and test them on the odd ones.

Close = 95th and strong = 99th percentile of the best similarity left when a home-like photo's whole recall is removed
from the shipped int8 index (even ids). Reported on the odd ids for home-like and clean queries, next to the thresholds
set the same way on clean photos (eval_photo.py).

Usage: python3 calibrate_home.py <index_prefix> <home_even_prefix> <home_even_manifest> <home_odd_prefix>
                                 <home_odd_manifest> <eval_photo.json> <out.json>
"""
import json, sys
import numpy as np

(index_prefix, even_prefix, even_manifest, odd_prefix, odd_manifest, clean_eval, out_path) = sys.argv[1:8]
meta = json.load(open(index_prefix + ".json"))
rows = meta["rows"]
X = np.fromfile(index_prefix + ".f32", dtype=np.float32).reshape(len(rows), meta["dim"])
Xq = np.clip(np.round(X * 127), -127, 127).astype(np.int8).astype(np.float32) / 127
Xq /= np.linalg.norm(Xq, axis=1, keepdims=True)
rid = np.array([r["recallId"] for r in rows])
row_of = {r["file"]: i for i, r in enumerate(rows)}
by_recall = {}
for i, r in enumerate(rid):
    by_recall.setdefault(int(r), []).append(i)


def load(prefix, manifest):
    m = json.load(open(prefix + ".json"))
    A = np.fromfile(prefix + ".f32", dtype=np.float32).reshape(len(m["rows"]), m["dim"])
    src = {x["file"]: x["source_file"] for x in json.load(open(manifest))}
    return [(row_of[src[r["file"]]], A[i]) for i, r in enumerate(m["rows"])]


def top(q, exclude):
    s = Xq @ q
    s[exclude] = -9
    order = np.argsort(-s)
    seen, ranked, best = set(), [], []
    for j in order:
        r = int(rid[j])
        if r in seen:
            continue
        seen.add(r); ranked.append(r); best.append(float(s[j]))
        if len(ranked) >= 5:
            break
    return ranked, best


def collect(queries):
    pos, neg = [], []
    for src, q in queries:
        r = int(rid[src]); idx = by_recall[r]
        if len(idx) >= 2:
            ex = np.zeros(len(rows), bool); ex[src] = True
            ranked, best = top(q, ex)
            pos.append((ranked.index(r) + 1 if r in ranked else 99, best[0]))
        if src == idx[0]:
            ex = np.zeros(len(rows), bool); ex[idx] = True
            neg.append(top(q, ex)[1][0])
    return pos, np.array(neg)


def report(pos, neg, close, strong):
    k = np.array([p[0] for p in pos]); s1 = np.array([p[1] for p in pos])
    return {
        "queries": int(len(k)), "top1": round(float((k == 1).mean()), 4), "top5": round(float((k <= 5).mean()), 4),
        "right_first_and_called_lookalike": round(float(((k == 1) & (s1 >= close)).mean()), 4),
        "share_of_right_first_called_lookalike": round(float((s1[k == 1] >= close).mean()), 4),
        "called_lookalike_any": round(float((s1 >= close).mean()), 4),
        "precision_of_lookalike_top1": round(float((k[s1 >= close] == 1).mean()), 4) if (s1 >= close).any() else None,
        "very_close_top1_precision": round(float((k[s1 >= strong] == 1).mean()), 4) if (s1 >= strong).any() else None,
        "held_out_recalls": int(len(neg)), "false_lookalike": round(float((neg >= close).mean()), 4),
        "false_very_close": round(float((neg >= strong).mean()), 4),
    }


even = load(even_prefix, even_manifest)
odd = load(odd_prefix, odd_manifest)
_, neg_even = collect(even)
close_h, strong_h = float(np.percentile(neg_even, 95)), float(np.percentile(neg_even, 99))
th = json.load(open(clean_eval))["int8_shipped"]["thresholds_from_even_recall_ids"]
pos_h, neg_h = collect(odd)
pos_c, neg_c = collect([(src, X[src]) for src, _ in odd])
out = {
    "home_thresholds_from_even_ids": {"close": round(close_h, 4), "strong": round(strong_h, 4), "negatives": int(len(neg_even))},
    "clean_thresholds": {"close": th["close"], "strong": th["strong"]},
    "odd_home_like@home_thresholds": report(pos_h, neg_h, close_h, strong_h),
    "odd_clean@home_thresholds": report(pos_c, neg_c, close_h, strong_h),
    "odd_home_like@clean_thresholds": report(pos_h, neg_h, th["close"], th["strong"]),
    "odd_clean@clean_thresholds": report(pos_c, neg_c, th["close"], th["strong"]),
}
json.dump(out, open(out_path, "w"), indent=1)
print(json.dumps(out, indent=1))
