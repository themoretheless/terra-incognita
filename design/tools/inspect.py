import json, sys, collections
d = json.load(open(sys.argv[1]))
els = d["elements"]
c = collections.Counter(e["type"] for e in els)
print("types", dict(c))
ways = [e for e in els if e["type"] == "way" and "tags" in e]
rels = [e for e in els if e["type"] == "relation"]
cnt = collections.Counter()
for w in ways:
    t = w["tags"]
    for k in ("building", "highway", "railway", "natural", "waterway", "leisure", "landuse", "man_made"):
        if k in t: cnt[(k, t[k])] += 1
for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])[:40]: print(k, v)
print("relations:")
for r in rels:
    t = r.get("tags", {})
    print(r["id"], {k: t.get(k) for k in ("type", "natural", "water", "name", "leisure")}, "members", len(r["members"]))
