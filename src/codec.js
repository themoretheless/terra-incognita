// @ts-check
/**
 * Кодирование битовых карт чанков.
 *
 * RLE для байтов: пустые (0x00) и полные (0xFF) серии сворачиваются в 3 байта,
 * остальное идёт литералами. Пройденный путь — это узкие ленты, поэтому
 * типичный чанк сжимается в десятки раз и без gzip.
 *
 * Формат: последовательность блоков
 *   0x00 lenLo lenHi           — len байтов 0x00
 *   0x01 lenLo lenHi           — len байтов 0xFF
 *   0x02 lenLo lenHi bytes...  — len литеральных байтов
 */

const ZERO = 0;
const FULL = 1;
const LITERAL = 2;
const MAX_RUN = 0xffff;

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function encodeRLE(bytes) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b === 0x00 || b === 0xff) {
      let j = i;
      while (j < n && bytes[j] === b && j - i < MAX_RUN) j += 1;
      const len = j - i;
      out.push(b === 0 ? ZERO : FULL, len & 0xff, len >> 8);
      i = j;
    } else {
      let j = i;
      while (j < n && bytes[j] !== 0x00 && bytes[j] !== 0xff && j - i < MAX_RUN) j += 1;
      const len = j - i;
      out.push(LITERAL, len & 0xff, len >> 8);
      for (let k = i; k < j; k += 1) out.push(bytes[k]);
      i = j;
    }
  }
  return Uint8Array.from(out);
}

/**
 * @param {Uint8Array} encoded
 * @param {number} size  — ожидаемый размер результата
 * @returns {Uint8Array}
 */
export function decodeRLE(encoded, size) {
  const out = new Uint8Array(size);
  let o = 0;
  let i = 0;
  while (i < encoded.length) {
    const tag = encoded[i];
    const len = encoded[i + 1] | (encoded[i + 2] << 8);
    i += 3;
    if (o + len > size) throw new Error('RLE: данные длиннее чанка');
    if (tag === ZERO) {
      o += len;
    } else if (tag === FULL) {
      out.fill(0xff, o, o + len);
      o += len;
    } else if (tag === LITERAL) {
      out.set(encoded.subarray(i, i + len), o);
      i += len;
      o += len;
    } else {
      throw new Error(`RLE: неизвестный тег ${tag}`);
    }
  }
  if (o !== size) throw new Error('RLE: данные короче чанка');
  return out;
}

/**
 * @param {Uint8Array} bytes
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

/**
 * @param {string} text
 */
export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * FNV-1a 32 бита — контрольная сумма экспорта (синхронная, одинаковая в браузере и Node).
 * @param {Iterable<Uint8Array | string>} parts
 */
export function fnv1a(parts) {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i += 1) {
        hash ^= part.charCodeAt(i) & 0xff;
        hash = Math.imul(hash, 0x01000193);
        hash ^= part.charCodeAt(i) >> 8;
        hash = Math.imul(hash, 0x01000193);
      }
    } else {
      for (let i = 0; i < part.length; i += 1) {
        hash ^= part[i];
        hash = Math.imul(hash, 0x01000193);
      }
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

/**
 * Число единичных битов.
 * @param {Uint8Array} bytes
 */
export function popcount(bytes) {
  let count = 0;
  for (let i = 0; i < bytes.length; i += 1) count += POPCOUNT[bytes[i]];
  return count;
}
