import sys
from PIL import Image
tiles_dir, out = sys.argv[1], sys.argv[2]
xs = list(range(33194, 33199)); ys = list(range(22544, 22548))
canvas = Image.new("RGB", (256 * len(xs), 256 * len(ys)), (238, 236, 230))
for i, x in enumerate(xs):
    for j, y in enumerate(ys):
        t = Image.open(f"{tiles_dir}/{x}_{y}.png").convert("RGB")
        canvas.paste(t, (i * 256, j * 256))
# centre (48.8566, 2.3522) -> tile (33196.21, 22546.30) -> pixel (566, 589) in this stitch
cx, cy = 566, 589
crop = canvas.crop((cx - 480, cy - 304, cx + 480, cy + 304))  # 960 x 608
crop.save(out, optimize=True)
print(crop.size)
