"""Photo search on degraded ("taken at home") copies of the test-half recall photos, against the shipped int8 index.

Queries are float embeddings, as in the browser; the index is the int8 rows the app ships. Positive queries leave
their own source photo out of the index; negative queries remove their whole recall. The look-alike threshold is the
shipped one (photo-index.json), so "called close" is what the app would show. The clean rows of the same photos are
run through the same protocol for a like-for-like baseline.

Usage: python3 eval_robust.py <index_prefix> <aug_prefix> <photo-index.json> <out.json> <aug_manifest.json>
"""
import json, sys
import numpy as np

index_prefix, aug_prefix, shipped_meta, out_path = sys.argv[1:5]
meta = json.load(open(index_prefix + ".json"))
rows = meta["rows"]
X = np.fromfile(index_prefix + ".f32", dtype=np.float32).reshape(len(rows), meta["dim"])
Xq = np.clip(np.round(X * 127), -127, 127).astype(np.int8).astype(np.float32) / 127
Xq /= np.linalg.norm(Xq, axis=1, keepdims=True)
ameta = json.load(open(aug_prefix + ".json"))
A = np.fromfile(aug_prefix + ".f32", dtype=np.float32).reshape(len(ameta["rows"]), ameta["dim"])
th = json.load(open(shipped_meta))
close = float(th["thresholds"]["close"])

rid = np.array([r["recallId"] for r in rows])
row_of = {r["file"]: i for i, r in enumerate(rows)}
by_recall = {}
for i, r in enumerate(rid):
    by_recall.setdefault(int(r), []).append(i)


def ranking(q, exclude):
    s = Xq @ q
    s[exclude] = -9
    order = np.argsort(-s)
    seen, ranked, best = set(), [], []
    for j in order:
        r = int(rid[j])
        if r in seen:
            continue
        seen.add(r); ranked.append(r); best.append(float(s[j]))
        if len(ranked) >= 50:
            break
    return ranked, best


def run(queries):
    """queries: list of (source row, query vector)."""
    pos, neg, first_seen = [], [], set()
    for src, q in queries:
        r = int(rid[src])
        idx = by_recall[r]
        if len(idx) >= 2:
            ex = np.zeros(len(rows), bool); ex[src] = True
            ranked, best = ranking(q, ex)
            k = ranked.index(r) + 1 if r in ranked else 999
            pos.append((k, best[0], best[k - 1] if k <= 50 else None))
        if r not in first_seen and src == idx[0]:
            first_seen.add(r)
            ex = np.zeros(len(rows), bool); ex[idx] = True
            _, best = ranking(q, ex)
            neg.append(best[0])
    k = np.array([p[0] for p in pos])
    hit_sims = np.array([p[2] for p in pos if p[0] == 1])
    neg = np.array(neg)
    return {
        "queries": int(len(k)),
        "top1": round(float((k <= 1).mean()), 4),
        "top5": round(float((k <= 5).mean()), 4),
        "top1_hits_called_close": round(float((hit_sims >= close).mean()), 4) if len(hit_sims) else None,
        "any_result_called_close": round(float((np.array([p[1] for p in pos]) >= close).mean()), 4),
        "held_out_recalls": int(len(neg)),
        "false_close": round(float((neg >= close).mean()), 4),
    }


src_of = {m["file"]: m["source_file"] for m in json.load(open(sys.argv[5]))}
aug_q = [(row_of[src_of[r["file"]]], A[i]) for i, r in enumerate(ameta["rows"])]
clean_q = [(src, X[src]) for src, _ in aug_q]
out = {"index": index_prefix, "close_threshold": close,
       "clean_float_query": run(clean_q), "home_like_float_query": run(aug_q)}
json.dump(out, open(out_path, "w"), indent=1)
print(json.dumps(out, indent=1))
