// Воркер растеризации: битовые карты чанков → ImageBitmap, основной поток свободен.
import { rasterizeMask, rasterizeHeat } from './raster.js';

self.onmessage = (event) => {
  const { id, kind, data, size } = event.data;
  const pixels = kind === 'heat' ? rasterizeHeat(data) : rasterizeMask(data, size);
  const side = kind === 'heat' ? 64 : size;
  const canvas = new OffscreenCanvas(side, side);
  const context = canvas.getContext('2d');
  context.putImageData(new ImageData(pixels, side, side), 0, 0);
  const bitmap = canvas.transferToImageBitmap();
  /** @type {any} */ (self).postMessage({ id, bitmap }, [bitmap]);
};
