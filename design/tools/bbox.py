import math
n = 2 ** 16
x0, y0 = 33194 + 86 / 256, 22544 + 285 / 256
x1, y1 = x0 + 960 / 256, y0 + 608 / 256
def lon(x): return x / n * 360 - 180
def lat(y): return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
print(f"{lat(y1):.6f},{lon(x0):.6f},{lat(y0):.6f},{lon(x1):.6f}")
