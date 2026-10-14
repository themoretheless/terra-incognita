// @ts-check
/**
 * Растеризация битовой карты чанка в RGBA нужного размера.
 * Общий код для воркера и для запасного пути в основном потоке.
 *
 * Уменьшенные уровни считают долю открытых клеток в блоке (покрытие),
 * поэтому при билинейном масштабировании край получается мягким без blur().
 */

const CHUNK = 256;

/**
 * @param {Uint8Array} bits  — 8192 байта, бит на клетку
 * @param {number} size      — 256, 128, 64 или 32
 * @returns {Uint8ClampedArray}
 */
export function rasterizeMask(bits, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const f = CHUNK / size;
  if (f === 1) {
    for (let i = 0; i < bits.length; i += 1) {
      const byte = bits[i];
      if (!byte) continue;
      for (let b = 0; b < 8; b += 1) {
        if (byte & (1 << b)) {
          const o = ((i << 3) | b) << 2;
          out[o] = 255;
          out[o + 1] = 255;
          out[o + 2] = 255;
          out[o + 3] = 255;
        }
      }
    }
    return out;
  }
  const counts = new Uint16Array(size * size);
  const shift = Math.log2(f);
  for (let i = 0; i < bits.length; i += 1) {
    const byte = bits[i];
    if (!byte) continue;
    for (let b = 0; b < 8; b += 1) {
      if (!(byte & (1 << b))) continue;
      const idx = (i << 3) | b;
      const x = (idx & 255) >> shift;
      const y = (idx >> 8) >> shift;
      counts[y * size + x] += 1;
    }
  }
  const full = f * f;
  for (let i = 0; i < counts.length; i += 1) {
    if (!counts[i]) continue;
    const o = i << 2;
    out[o] = 255;
    out[o + 1] = 255;
    out[o + 2] = 255;
    out[o + 3] = Math.round((counts[i] / full) * 255);
  }
  return out;
}

/**
 * Тепловая карта 64×64 → RGBA (от холодного жёлтого к горячему красному).
 * @param {Uint8Array} heat
 * @returns {Uint8ClampedArray}
 */
export function rasterizeHeat(heat) {
  const out = new Uint8ClampedArray(heat.length * 4);
  for (let i = 0; i < heat.length; i += 1) {
    const v = heat[i];
    if (!v) continue;
    const k = Math.min(1, Math.log2(v + 1) / 5);
    const o = i << 2;
    out[o] = 255;
    out[o + 1] = Math.round(220 - 190 * k);
    out[o + 2] = Math.round(60 - 60 * k);
    out[o + 3] = Math.round(90 + 140 * k);
  }
  return out;
}
