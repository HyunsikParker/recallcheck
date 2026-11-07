"""Proxy evaluation of photo search on CPSC recall photos.

Positive queries: for every recall with two or more photos, each photo is a query against an index
that holds every other photo (its own photo removed). A hit at k means a photo of the same recall
ranks in the top k recalls.

Negative queries: each recall is held out entirely (all its photos removed) and its first photo is
the query. The best similarity left shows what "no recall in the index" looks like, which sets the
"no close match" threshold.

Usage: python3 eval_photo.py <prefix> <out.json> [recalls.json]   (prefix.f32 + prefix.json from embed_dino.mjs)
With recalls.json, recalls of the same product (product-name Jaccard >= 0.6) are scored as one group.
That grouping also merges different brands' generic products, so the reported numbers do not use it.
"""
import json
import sys

import numpy as np

prefix, out_path = sys.argv[1], sys.argv[2]
meta = json.load(open(prefix + ".json"))
rows = meta["rows"]
X = np.fromfile(prefix + ".f32", dtype=np.float32).reshape(len(rows), meta["dim"])

# int8 quantisation as shipped to the browser
Xq = np.clip(np.round(X * 127), -127, 127).astype(np.int8).astype(np.float32) / 127
Xq /= np.linalg.norm(Xq, axis=1, keepdims=True)

rid_raw = np.array([r["recallId"] for r in rows])

# Some products were recalled more than once (re-announced or expanded recalls). Recalls whose product
# names nearly match are merged into one group, so finding the earlier recall of the same product counts
# as a hit and is not counted as a false match.
import re as _re
_cards = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
_STOP = {"recalled", "recall", "recalls", "model", "models", "inch", "with", "and", "the", "for", "sold",
         "exclusively", "from", "new", "year", "years", "series"}


def _tokens(r):
    c = _cards.get(f"cpsc:{r}", {})
    words = _re.findall(r"[a-z0-9]+", (c.get("product") or c.get("title") or "").lower())
    return {w for w in words if len(w) >= 3 and w not in _STOP}


_ids = sorted(set(int(r) for r in rid_raw))
_parent = {r: r for r in _ids}


def _find(r):
    while _parent[r] != r:
        _parent[r] = _parent[_parent[r]]
        r = _parent[r]
    return r


if _cards:
    _tok = {r: _tokens(r) for r in _ids}
    for i, a in enumerate(_ids):
        ta = _tok[a]
        if not ta:
            continue
        for b in _ids[i + 1:]:
            tb = _tok[b]
            if tb and len(ta & tb) / len(ta | tb) >= 0.6:
                _parent[_find(a)] = _find(b)
rid = np.array([_find(int(r)) for r in rid_raw])
print("recalls", len(_ids), "groups", len(set(rid.tolist())), file=sys.stderr)
by_recall = {}
for i, r in enumerate(rid):
    by_recall.setdefault(int(r), []).append(i)


def recall_ranking(sims, exclude_mask):
    """Best similarity per recall, ranked high to low."""
    s = sims.copy()
    s[exclude_mask] = -9
    order = np.argsort(-s)
    seen, ranked, best = set(), [], []
    for j in order:
        r = int(rid[j])
        if r in seen:
            continue
        seen.add(r)
        ranked.append(r)
        best.append(float(s[j]))
        if len(ranked) >= 50:
            break
    return ranked, best


def evaluate(M):
    S = M @ M.T
    pos = []  # (recall, rank, sim of the true recall)
    for r, idx in by_recall.items():
        if len(idx) < 2:
            continue
        for q in idx:
            ex = np.zeros(len(rows), bool)
            ex[q] = True
            ranked, best = recall_ranking(S[q], ex)
            if r in ranked:
                pos.append((r, ranked.index(r) + 1, best[ranked.index(r)]))
            else:
                pos.append((r, 999, None))
    neg = {}  # recall -> best similarity once the recall is removed from the index
    for r, idx in by_recall.items():
        ex = np.zeros(len(rows), bool)
        ex[idx] = True
        _, best = recall_ranking(S[idx[0]], ex)
        neg[r] = best[0]

    def summary(recall_ids, thr):
        rk = np.array([k for r, k, _ in pos if r in recall_ids])
        t1 = np.array([s for r, k, s in pos if r in recall_ids and k == 1])
        ng = np.array([v for r, v in neg.items() if r in recall_ids])
        return {
            "queries": int(len(rk)),
            "top1": round(float((rk <= 1).mean()), 4),
            "top5": round(float((rk <= 5).mean()), 4),
            "top1_hits_called_close": round(float((t1 >= thr).mean()), 4),
            "held_out_recalls": int(len(ng)),
            "false_close": round(float((ng >= thr).mean()), 4),
        }

    calib = {r for r in by_recall if r % 2 == 0}
    test = {r for r in by_recall if r % 2 == 1}
    neg_cal = np.array([neg[r] for r in calib])
    close = float(np.percentile(neg_cal, 95))
    strong = float(np.percentile(neg_cal, 99))
    return {
        "thresholds_from_even_recall_ids": {"close": round(close, 4), "strong": round(strong, 4)},
        "test_odd_recall_ids": summary(test, close),
        "all": summary(set(by_recall), close),
        "neg_best_sim_p50_p95_p99": [round(float(np.percentile(list(neg.values()), p)), 4) for p in (50, 95, 99)],
    }


out = {"model": meta["model"], "dtype": meta["dtype"], "rows": len(rows),
       "float32": evaluate(X), "int8_shipped": evaluate(Xq)}
json.dump(out, open(out_path, "w"), indent=1)
print(json.dumps(out, indent=1))
