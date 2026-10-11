import json, math, random, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SRC, OUT_H3, OUT_RD = sys.argv[1], sys.argv[2], sys.argv[3]
S = 2                      # supersampling
W, H = 960 * S, 608 * S
N = 2 ** 16
X0, Y0 = 33194 + 86 / 256, 22544 + 285 / 256
random.seed(7)

def project(lat, lon):
    xt = (lon + 180) / 360 * N
    yt = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * N
    return ((xt - X0) * 256 * S, (yt - Y0) * 256 * S)

data = json.load(open(SRC))
nodes, ways, rels = {}, {}, []
for e in data["elements"]:
    if e["type"] == "node":
        nodes[e["id"]] = project(e["lat"], e["lon"])
    elif e["type"] == "way":
        ways[e["id"]] = e
    elif e["type"] == "relation":
        rels.append(e)

def coords(w):
    return [nodes[n] for n in w["nodes"] if n in nodes]

def assemble(segments):
    segs = [list(s) for s in segments if len(s) > 1]
    rings = []
    while segs:
        ring = segs.pop()
        changed = True
        while changed and ring[0] != ring[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]: ring += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[-1]: ring += list(reversed(s))[1:]; segs.pop(i); changed = True; break
                if s[-1] == ring[0]: ring = s[:-1] + ring; segs.pop(i); changed = True; break
                if s[0] == ring[0]: ring = list(reversed(s))[:-1] + ring; segs.pop(i); changed = True; break
        rings.append(ring)
    return rings

water_outer, water_inner = [], []
for r in rels:
    t = r.get("tags", {})
    if t.get("natural") == "water" or t.get("type") == "multipolygon":
        outs = [coords(ways[m["ref"]]) for m in r["members"] if m["type"] == "way" and m["ref"] in ways and m.get("role") != "inner"]
        ins = [coords(ways[m["ref"]]) for m in r["members"] if m["type"] == "way" and m["ref"] in ways and m.get("role") == "inner"]
        water_outer += assemble(outs)
        water_inner += assemble(ins)

buildings, greens, parks, roads, rails, bridges, water_ways = [], [], [], [], [], [], []
for w in ways.values():
    t = w.get("tags")
    if not t: continue
    pts = coords(w)
    if len(pts) < 2: continue
    if "building" in t and t["building"] != "roof":
        buildings.append(pts)
    elif t.get("natural") == "water":
        water_outer.append(pts)
    elif t.get("leisure") in ("park", "garden") or t.get("natural") == "wood" or t.get("landuse") in ("forest", "cemetery"):
        greens.append(pts); parks.append(pts)
    elif t.get("leisure") in ("playground", "pitch") or t.get("landuse") in ("grass", "recreation_ground", "village_green"):
        greens.append(pts)
    elif t.get("man_made") == "bridge":
        bridges.append(pts)
    elif "highway" in t:
        h = t["highway"]
        if h in ("footway", "steps", "corridor", "elevator", "path", "cycleway", "platform", "bus_stop"): continue
        cls = "major" if h in ("motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link") else \
              "mid" if h in ("tertiary", "residential", "unclassified", "secondary_link", "tertiary_link") else \
              "ped" if h in ("pedestrian",) else "minor"
        roads.append((cls, pts, t.get("bridge") == "yes"))
    elif t.get("railway") == "rail" and t.get("tunnel") != "yes":
        rails.append(pts)

def poly_bbox(p):
    xs = [q[0] for q in p]; ys = [q[1] for q in p]
    return min(xs), min(ys), max(xs), max(ys)

def inside(pt, poly):
    x, y = pt; n = len(poly); j = n - 1; r = False
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi): r = not r
        j = i
    return r

def scatter(polys, spacing):
    out = []
    for p in polys:
        if len(p) < 3: continue
        x0, y0, x1, y1 = poly_bbox(p)
        area = (x1 - x0) * (y1 - y0)
        n = int(area / (spacing * spacing))
        for _ in range(min(n, 400)):
            q = (random.uniform(x0, x1), random.uniform(y0, y1))
            if q[0] < -20 or q[1] < -20 or q[0] > W + 20 or q[1] > H + 20: continue
            if inside(q, p): out.append(q)
    out.sort(key=lambda q: q[1])
    return out

def dashed(draw, pts, dash, gap, fill, width):
    on, carry = True, 0.0
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, by - ay)
        if L == 0: continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        pos = 0.0
        while pos < L:
            seg = (dash if on else gap) - carry
            end = min(L, pos + seg)
            if on: draw.line([(ax + ux * pos, ay + uy * pos), (ax + ux * end, ay + uy * end)], fill=fill, width=width)
            if end >= L: carry += (L - pos); 
            else: carry = 0; on = not on
            pos = end
        if carry >= (dash if on else gap): carry = 0; on = not on

def ticks(draw, pts, every, length, fill, width):
    for (ax, ay), (bx, by) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, by - ay)
        if L == 0: continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        pos = every / 2
        while pos < L:
            cx, cy = ax + ux * pos, ay + uy * pos
            draw.line([(cx - uy * length, cy + ux * length), (cx + uy * length, cy - ux * length)], fill=fill, width=width)
            pos += every

def noise_layer(sigma, blur):
    n = Image.effect_noise((W, H), sigma).filter(ImageFilter.GaussianBlur(blur))
    return n

water_mask = Image.new("L", (W, H), 0)
md = ImageDraw.Draw(water_mask)
for p in water_outer: md.polygon(p, fill=255)
for p in water_inner: md.polygon(p, fill=0)
water_rings = water_outer + water_inner
def water_points(spacing):
    out = []
    for _ in range(int(W * H / (spacing * spacing))):
        q = (random.uniform(0, W), random.uniform(0, H))
        if water_mask.getpixel((int(q[0]), int(q[1]))) > 128: out.append(q)
    return out

# ---------- Heroes III style ----------
img = Image.new("RGB", (W, H), (90, 146, 52))
tex = noise_layer(40, 3).convert("RGB")
img = Image.blend(img, ImageChops.multiply(img, tex), 0.35)
img = Image.blend(img, ImageChops.screen(img, noise_layer(60, 60).convert("RGB")), 0.18)
d = ImageDraw.Draw(img, "RGBA")
for p in greens: d.polygon(p, fill=(70, 128, 44))
for p in greens: d.line(p + [p[0]], fill=(58, 108, 36), width=3, joint="curve")
# water: sand on both shores, then water with dark bank and waves composited through the mask
for p in water_rings: d.line(p + [p[0]], fill=(198, 171, 110), width=12 * S, joint="curve")
wimg = Image.new("RGB", (W, H), (43, 93, 158)); wd = ImageDraw.Draw(wimg, "RGBA")
for p in water_rings: wd.line(p + [p[0]], fill=(26, 68, 120), width=7 * S, joint="curve")
for p in water_rings: wd.line(p + [p[0]], fill=(59, 112, 181, 90), width=22 * S, joint="curve")
for q in water_points(16 * S):
    x, y = q
    wd.line([(x - 7 * S, y + 1.5 * S), (x - 2.5 * S, y - 1.5 * S), (x + 2.5 * S, y + 1.5 * S), (x + 7 * S, y - 1.5 * S)], fill=(143, 189, 232, 200), width=2 * S // 2 + 1)
img = Image.composite(wimg, img, water_mask); d = ImageDraw.Draw(img, "RGBA")
# buildings as stone blocks
sh = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sd = ImageDraw.Draw(sh)
for p in buildings: sd.polygon([(x + 3 * S, y + 4 * S) for x, y in p], fill=(0, 0, 0, 90))
sh = sh.filter(ImageFilter.GaussianBlur(2))
img = Image.alpha_composite(img.convert("RGBA"), sh).convert("RGB"); d = ImageDraw.Draw(img, "RGBA")
for p in buildings: d.polygon(p, fill=(142, 125, 104))
for p in buildings: d.line(p + [p[0]], fill=(78, 64, 50), width=2, joint="curve")
# roads
widths = {"major": (20, 15), "mid": (14, 10), "ped": (11, 8), "minor": (9, 6)}
for cls, pts, br in roads:
    e, f = widths[cls]; d.line(pts, fill=(104, 78, 46), width=e * S // 2 + 2, joint="curve")
for cls, pts, br in roads:
    e, f = widths[cls]
    col = (163, 123, 69) if br else ((160, 133, 80) if cls == "ped" else (139, 107, 62))
    d.line(pts, fill=col, width=f * S // 2 + 1, joint="curve")
for cls, pts, br in roads:
    if br: d.line(pts, fill=(58, 42, 28), width=2, joint="curve")
for p in bridges: d.line(p + [p[0]], fill=(58, 42, 28), width=2, joint="curve")
for pts in rails:
    d.line(pts, fill=(70, 70, 76), width=3 * S // 2 + 1, joint="curve"); ticks(d, pts, 7 * S, 4 * S, (50, 44, 40), 2)
# trees in parks
for (x, y) in scatter(parks, 13 * S):
    s = random.uniform(0.8, 1.2) * S
    d.ellipse([x - 9 * s + 3 * s, y + 4 * s, x + 9 * s + 3 * s, y + 10 * s], fill=(0, 0, 0, 70))
    d.rectangle([x - 1.5 * s, y + 2 * s, x + 1.5 * s, y + 8 * s], fill=(90, 58, 30))
    for (ox, oy, r, col) in ((0, 0, 8, (31, 90, 30)), (-5, -3, 6, (31, 90, 30)), (5, -2, 6, (31, 90, 30)), (0, -6, 5, (31, 90, 30)),
                             (-1, -2, 6, (63, 138, 46)), (-4, -5, 4, (63, 138, 46)), (4, -4, 4, (63, 138, 46)), (-3, -6, 2.5, (124, 194, 86))):
        d.ellipse([x + ox * s - r * s, y + oy * s - r * s, x + ox * s + r * s, y + oy * s + r * s], fill=col)
img.resize((960, 608), Image.LANCZOS).save(OUT_H3, optimize=True)

# ---------- Red Dead parchment style ----------
INK = (58, 42, 28)
img = Image.new("RGB", (W, H), (231, 214, 177))
grain = noise_layer(70, 0.6).convert("RGB")
img = Image.blend(img, ImageChops.multiply(img, grain), 0.14)
stain = Image.new("RGB", (W, H), (231, 214, 177)); sd = ImageDraw.Draw(stain)
for _ in range(7):
    cx, cy = random.uniform(0, W), random.uniform(0, H); rx, ry = random.uniform(120, 260) * S, random.uniform(70, 160) * S
    sd.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(214, 190, 142))
stain = stain.filter(ImageFilter.GaussianBlur(60))
img = Image.blend(img, ImageChops.multiply(img, stain), 0.5)
d = ImageDraw.Draw(img, "RGBA")
for p in greens: d.polygon(p, fill=(214, 208, 160))
for p in greens: d.line(p + [p[0]], fill=(150, 140, 96), width=2, joint="curve")
wimg = Image.new("RGB", (W, H), (197, 207, 192)); wd = ImageDraw.Draw(wimg, "RGBA")
wimg = Image.blend(wimg, ImageChops.multiply(wimg, grain), 0.12); wd = ImageDraw.Draw(wimg, "RGBA")
for p in water_rings: wd.line(p + [p[0]], fill=(86, 99, 79, 90), width=14 * S, joint="curve")
for p in water_rings: wd.line(p + [p[0]], fill=(86, 99, 79, 110), width=7 * S, joint="curve")
for q in water_points(18 * S):
    x, y = q
    wd.line([(x - 7 * S, y), (x - 3 * S, y - 1.5 * S), (x + 1 * S, y), (x + 5 * S, y - 1.5 * S)], fill=(86, 99, 79, 150), width=2)
img = Image.composite(wimg, img, water_mask); d = ImageDraw.Draw(img, "RGBA")
for p in water_rings: d.line(p + [p[0]], fill=(60, 72, 56), width=2 * S, joint="curve")
for p in buildings: d.polygon(p, fill=(214, 195, 154))
for p in buildings: d.line(p + [p[0]], fill=(90, 70, 48), width=2, joint="curve")
for cls, pts, br in roads:
    if cls in ("major", "mid"): d.line(pts, fill=INK, width=(10 if cls == "major" else 7) * S // 2 + 1, joint="curve")
for cls, pts, br in roads:
    if cls in ("major", "mid"): d.line(pts, fill=(226, 208, 170), width=(7 if cls == "major" else 4) * S // 2 + 1, joint="curve")
for cls, pts, br in roads:
    if cls == "minor": d.line(pts, fill=INK, width=2, joint="curve")
    if cls == "ped": dashed(d, pts, 7 * S, 5 * S, INK, 2)
for cls, pts, br in roads:
    if br: ticks(d, pts, 6 * S, 5 * S, INK, 2)
for p in bridges: d.line(p + [p[0]], fill=INK, width=2, joint="curve")
for pts in rails:
    d.line(pts, fill=INK, width=2 * S, joint="curve"); ticks(d, pts, 8 * S, 3 * S, INK, 2)
for (x, y) in scatter(parks, 17 * S):
    r = random.uniform(2.6, 3.6) * S
    d.line([(x, y + 2 * S), (x, y + 8 * S)], fill=INK, width=2)
    d.ellipse([x - r, y - r, x + r, y + r], fill=(206, 196, 150), outline=INK, width=2)
img.resize((960, 608), Image.LANCZOS).save(OUT_RD, optimize=True)
print("ok", len(buildings), "buildings", len(roads), "roads", len(water_outer), "water rings", len(parks), "parks")
