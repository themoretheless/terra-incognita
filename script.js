const start = [48.8566, 2.3522];
const moveStepMeters = 30;
const revealRadiusMeters = 30;
const discoveryRadiusMeters = 60;
const sectorAreaSquareMeters = 1000 * 1000; // «сектор» для процента — квадратный километр вокруг лагеря
const PLAYER_KEY = 'terra-player';
const POI_KEY = 'terra-pois';

const fog = new FogStore();
const revealSpots = [];          // идущие сейчас анимации проявления
let animationFrame = null;
let zoomPercent = 100;
let lastRevealKey = '';

const pointsOfInterest = [
  { id: 'camp', lat: start[0], lng: start[1], discovered: true },
  { id: 'tower', lat: start[0] + 0.00165, lng: start[1] + 0.00062, discovered: false },
  { id: 'crossing', lat: start[0] - 0.00058, lng: start[1] + 0.00215, discovered: false }
];

const savedPlayer = readJSON(PLAYER_KEY);
const player = savedPlayer && Number.isFinite(savedPlayer.lat) && Number.isFinite(savedPlayer.lng)
  ? { lat: savedPlayer.lat, lng: savedPlayer.lng }
  : { lat: start[0], lng: start[1] };
const savedPois = readJSON(POI_KEY) || {};
pointsOfInterest.forEach((poi) => { if (savedPois[poi.id]) poi.discovered = true; });

const mapViewport = document.querySelector('#map-viewport');
const playerEl = document.querySelector('#player');
const fogCanvas = document.querySelector('#fog-canvas');
const progressBar = document.querySelector('#progress-bar');
const progressValue = document.querySelector('#progress-value');
const progressCaption = document.querySelector('#progress-caption');
const coordinates = document.querySelector('#coordinates');
const discoveryCountEl = document.querySelector('#discovery-count');
const discoveryList = document.querySelector('#discovery-list');
const savedAtEl = document.querySelector('#saved-at');
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([player.lat, player.lng], 14);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const fogContext = fogCanvas.getContext('2d');
const maskCanvas = document.createElement('canvas');
const maskContext = maskCanvas.getContext('2d');
const fogColors = {
  terra: 'rgba(16, 27, 40, .94)',
  heroes: 'rgba(0, 0, 0, .98)',
  western: 'rgba(226, 205, 168, .82)'
};
const savedTheme = localStorage.getItem('terra-theme') || 'terra';
document.documentElement.dataset.theme = savedTheme;
document.querySelectorAll('.theme-button').forEach((button) => {
  button.classList.toggle('active', button.dataset.theme === savedTheme);
  button.addEventListener('click', () => {
    const theme = button.dataset.theme;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('terra-theme', theme);
    document.querySelectorAll('.theme-button').forEach((item) => item.classList.toggle('active', item === button));
    drawFog();
  });
});

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (error) { return null; }
}

function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* хранилище недоступно */ }
}

function metersToLatitude(meters) {
  return meters / 111320;
}

function metersToLongitude(meters, lat) {
  return meters / (111320 * Math.max(.01, Math.cos(lat * Math.PI / 180)));
}

function distanceInMeters(lat1, lng1, lat2, lng2) {
  const latMeters = (lat1 - lat2) * 111320;
  const lngMeters = (lng1 - lng2) * 111320 * Math.max(.01, Math.cos(lat1 * Math.PI / 180));
  return Math.sqrt(latMeters * latMeters + lngMeters * lngMeters);
}

function updateDiscoveries() {
  let discoveredCount = 0;
  let changed = false;
  pointsOfInterest.forEach((poi) => {
    const entry = discoveryList.querySelector(`[data-poi="${poi.id}"]`);
    if (!poi.discovered) {
      const distance = distanceInMeters(player.lat, player.lng, poi.lat, poi.lng);
      if (distance <= discoveryRadiusMeters) {
        poi.discovered = true;
        changed = true;
      } else if (entry) {
        const label = entry.querySelector('small');
        if (label) label.textContent = `Расстояние: ${Math.round(distance)} м`;
      }
    }
    if (poi.discovered) {
      discoveredCount += 1;
      if (entry && !entry.classList.contains('found')) {
        entry.classList.add('found');
        const icon = entry.querySelector('.discovery-icon');
        const mark = entry.querySelector('i');
        const label = entry.querySelector('small');
        if (icon) icon.textContent = '✓';
        if (mark) mark.textContent = '✓';
        if (label) label.textContent = 'Обнаружено';
      }
    }
  });
  discoveryCountEl.textContent = `${discoveredCount} / ${pointsOfInterest.length}`;
  if (changed) {
    const state = {};
    pointsOfInterest.forEach((poi) => { if (poi.discovered) state[poi.id] = true; });
    writeJSON(POI_KEY, state);
  }
}

function updateProgress() {
  const area = fog.revealedArea(start[0]);
  const percentage = Math.min(100, area / sectorAreaSquareMeters * 100);
  const shown = percentage < 10 ? percentage.toFixed(1) : Math.round(percentage);
  progressBar.style.width = `${percentage}%`;
  progressValue.textContent = `${shown}%`;
  const hectares = area / 10000;
  const areaText = hectares >= 100 ? `${(hectares / 100).toFixed(2)} км²` : `${hectares.toFixed(2)} га`;
  progressCaption.textContent = percentage > 70 ? `Большая часть сектора изучена · ${areaText}` : percentage > 35 ? `Следы ведут всё дальше · ${areaText}` : `Путь только начинается · ${areaText}`;
}

function radiusInPixels(lat, lng, meters) {
  const center = map.latLngToContainerPoint([lat, lng]);
  const edge = map.latLngToContainerPoint([lat, lng + metersToLongitude(meters, lat)]);
  return Math.max(4, Math.abs(edge.x - center.x));
}

let lastFogWidth = -1;
let lastFogHeight = -1;

function drawFog() {
  const bounds = mapViewport.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const theme = document.documentElement.dataset.theme || 'terra';
  const pixelWidth = Math.round(bounds.width * ratio);
  const pixelHeight = Math.round(bounds.height * ratio);
  if (pixelWidth !== lastFogWidth || pixelHeight !== lastFogHeight) {
    fogCanvas.width = pixelWidth;
    fogCanvas.height = pixelHeight;
    maskCanvas.width = pixelWidth;
    maskCanvas.height = pixelHeight;
    lastFogWidth = pixelWidth;
    lastFogHeight = pixelHeight;
  }
  fogContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  maskContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  maskContext.clearRect(0, 0, bounds.width, bounds.height);
  fogContext.globalCompositeOperation = 'source-over';
  fogContext.fillStyle = fogColors[theme];
  fogContext.fillRect(0, 0, bounds.width, bounds.height);
  drawFogTexture(bounds, theme);

  drawStoredReveal(theme);

  const now = performance.now();
  let animating = false;
  for (let i = revealSpots.length - 1; i >= 0; i -= 1) {
    const spot = revealSpots[i];
    const point = map.latLngToContainerPoint([spot.lat, spot.lng]);
    const radius = radiusInPixels(spot.lat, spot.lng, revealRadiusMeters);
    const progress = Math.min(1, (now - spot.createdAt) / spot.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (progress < 1) {
      animating = true;
    } else {
      spot.cells.forEach((cell) => cell.chunk.show(cell.index));
      revealSpots.splice(i, 1);
    }
    if (theme === 'heroes') {
      drawHeroesReveal(point, radius, eased);
    } else if (theme === 'western') {
      drawWesternReveal(point, radius, spot.id, eased);
    } else {
      drawTerraReveal(point, radius, eased);
    }
  }
  fogContext.globalCompositeOperation = 'destination-out';
  fogContext.drawImage(maskCanvas, 0, 0, bounds.width, bounds.height);
  fogContext.globalCompositeOperation = 'source-over';
  animationFrame = null;
  if (animating) queueFogAnimation();
}

/**
 * Накопленные открытые области: по одному drawImage на видимый чанк.
 * В теме heroes клетки остаются чёткими и привязанными к карте, в остальных
 * темах край смягчается размытием пропорционально текущему масштабу.
 */
function drawStoredReveal(theme) {
  const mapBounds = map.getBounds();
  const chunks = fog.chunksInBounds({
    north: mapBounds.getNorth(), south: mapBounds.getSouth(), west: mapBounds.getWest(), east: mapBounds.getEast()
  });
  if (!chunks.length) return;
  const radiusPx = radiusInPixels(player.lat, player.lng, revealRadiusMeters);
  maskContext.save();
  if (theme === 'heroes') {
    maskContext.imageSmoothingEnabled = false;
    maskContext.filter = 'none';
  } else {
    maskContext.imageSmoothingEnabled = true;
    maskContext.imageSmoothingQuality = 'high';
    maskContext.filter = `blur(${Math.max(1, radiusPx * (theme === 'western' ? .22 : .14)).toFixed(1)}px)`;
  }
  chunks.forEach((chunk) => {
    const b = fog.chunkBounds(chunk);
    const nw = map.latLngToContainerPoint([b.north, b.west]);
    const se = map.latLngToContainerPoint([b.south, b.east]);
    maskContext.drawImage(chunk.image(), nw.x, nw.y, se.x - nw.x, se.y - nw.y);
  });
  maskContext.restore();
}

function drawFogTexture(bounds, theme) {
  if (theme === 'heroes') {
    fogContext.strokeStyle = 'rgba(107, 84, 37, .18)';
    fogContext.lineWidth = 1;
    for (let x = 0; x < bounds.width; x += 34) {
      fogContext.beginPath(); fogContext.moveTo(x, 0); fogContext.lineTo(x, bounds.height); fogContext.stroke();
    }
    for (let y = 0; y < bounds.height; y += 34) {
      fogContext.beginPath(); fogContext.moveTo(0, y); fogContext.lineTo(bounds.width, y); fogContext.stroke();
    }
    return;
  }
  if (theme === 'western') {
    fogContext.fillStyle = 'rgba(255, 241, 207, .2)';
    for (let y = 0; y < bounds.height; y += 9) fogContext.fillRect(0, y, bounds.width, 1);
    fogContext.fillStyle = 'rgba(91, 56, 30, .13)';
    for (let x = 0; x < bounds.width; x += 17) fogContext.fillRect(x, 0, 1, bounds.height);
    const vignette = fogContext.createRadialGradient(bounds.width / 2, bounds.height / 2, bounds.width * .12, bounds.width / 2, bounds.height / 2, bounds.width * .75);
    vignette.addColorStop(0, 'rgba(255,255,255,0)');
    vignette.addColorStop(1, 'rgba(88,49,24,.22)');
    fogContext.fillStyle = vignette;
    fogContext.fillRect(0, 0, bounds.width, bounds.height);
  }
}

function drawTerraReveal(point, targetRadius, progress) {
  const shape = buildIrregularShape(point, targetRadius, progress, `terra:${Math.round(point.x)}:${Math.round(point.y)}`, 32, .16);
  const gradient = maskContext.createRadialGradient(point.x, point.y, targetRadius * .36 * progress, point.x, point.y, targetRadius * progress);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(.62, 'rgba(255,255,255,.94)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  maskContext.save();
  drawPath(maskContext, shape);
  maskContext.clip();
  maskContext.fillStyle = gradient;
  maskContext.fillRect(point.x - targetRadius, point.y - targetRadius, targetRadius * 2, targetRadius * 2);
  maskContext.restore();
}

function buildIrregularShape(point, targetRadius, progress, seed, points, variance) {
  const shape = [];
  for (let i = 0; i <= points; i += 1) {
    const angle = (Math.PI * 2 * i) / points;
    const wave = Math.sin(angle * 3 + seededNoise(seed, i + 100) * Math.PI) * variance;
    const edge = 1 - variance + seededNoise(seed, i) * variance + wave;
    const radius = targetRadius * edge * (.18 + progress * .82);
    shape.push([point.x + Math.cos(angle) * radius, point.y + Math.sin(angle) * radius]);
  }
  return shape;
}

function drawPath(context, shape) {
  context.beginPath();
  shape.forEach(([x, y], index) => {
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.closePath();
}

function drawHeroesReveal(point, targetRadius, progress) {
  const tile = Math.max(8, targetRadius / 2.25);
  const maxDistance = Math.max(2, Math.ceil(targetRadius / tile));
  maskContext.save();
  maskContext.filter = 'none';
  maskContext.fillStyle = 'rgba(255,255,255,1)';
  for (let row = -maxDistance; row <= maxDistance; row += 1) {
    for (let column = -maxDistance; column <= maxDistance; column += 1) {
      const distance = Math.abs(row) + Math.abs(column) * .9;
      const edgeNoise = seededNoise(`${row}:${column}`, 3) > .42 ? .75 : 0;
      const ringIsVisible = progress * (maxDistance + 1.8) >= distance * .72;
      if (distance <= maxDistance + edgeNoise && ringIsVisible) {
        const x = Math.round((point.x + column * tile) / tile) * tile;
        const y = Math.round((point.y + row * tile) / tile) * tile;
        maskContext.globalAlpha = 1;
        maskContext.fillRect(x - tile / 2, y - tile / 2, tile - 1, tile - 1);
      }
    }
  }
  maskContext.restore();
}

function seededNoise(seed, index) {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) value = (value * 31 + seed.charCodeAt(i) + index * 17) % 9973;
  return (Math.sin(value) + 1) / 2;
}

function drawWesternReveal(point, targetRadius, seed, progress) {
  const shape = buildIrregularShape(point, targetRadius, progress, seed, 38, .26);
  const gradient = maskContext.createRadialGradient(point.x, point.y, targetRadius * .22 * progress, point.x, point.y, targetRadius * progress);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(.48, 'rgba(255,255,255,.9)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  maskContext.save();
  drawPath(maskContext, shape);
  maskContext.clip();
  maskContext.fillStyle = gradient;
  maskContext.fillRect(point.x - targetRadius, point.y - targetRadius, targetRadius * 2, targetRadius * 2);
  maskContext.globalAlpha = .28;
  maskContext.filter = `blur(${Math.max(3, targetRadius * .16)}px)`;
  for (let i = 0; i < Math.ceil(7 * progress); i += 1) {
    const angle = Math.PI * 2 * seededNoise(seed, i + 40);
    const blotRadius = targetRadius * (.08 + seededNoise(seed, i + 90) * .12) * progress;
    const distance = targetRadius * (.15 + seededNoise(seed, i + 70) * .55) * progress;
    maskContext.beginPath();
    maskContext.arc(point.x + Math.cos(angle) * distance, point.y + Math.sin(angle) * distance, blotRadius, 0, Math.PI * 2);
    maskContext.fill();
  }
  maskContext.restore();
}

function queueFogAnimation() {
  if (!animationFrame) animationFrame = requestAnimationFrame(drawFog);
}

function revealAround(animate) {
  const cell = fog.cellOf(player.lat, player.lng);
  const revealKey = `${cell.x},${cell.y}`;
  if (revealKey === lastRevealKey) return;
  lastRevealKey = revealKey;
  const added = fog.reveal(player.lat, player.lng, revealRadiusMeters);
  if (!added.length) return;
  if (animate) {
    const theme = document.documentElement.dataset.theme || 'terra';
    revealSpots.push({ id: revealKey, lat: player.lat, lng: player.lng, cells: added, createdAt: performance.now(), duration: theme === 'heroes' ? 180 : 760 });
  } else {
    added.forEach((item) => item.chunk.show(item.index));
  }
  updateProgress();
}

function render(animateReveal = true) {
  const point = map.latLngToContainerPoint([player.lat, player.lng]);
  playerEl.style.left = `${point.x}px`;
  playerEl.style.top = `${point.y}px`;
  const latHemisphere = player.lat >= 0 ? 'N' : 'S';
  const lngHemisphere = player.lng >= 0 ? 'E' : 'W';
  coordinates.textContent = `${Math.abs(player.lat).toFixed(3)}° ${latHemisphere}   ${Math.abs(player.lng).toFixed(3)}° ${lngHemisphere}`;
  updateDiscoveries();
  revealAround(animateReveal);
  writeJSON(PLAYER_KEY, { lat: player.lat, lng: player.lng });
  queueFogAnimation();
}

function move(dx, dy) {
  player.lat -= dy * metersToLatitude(moveStepMeters);
  player.lng += dx * metersToLongitude(moveStepMeters, player.lat);
  map.panTo([player.lat, player.lng], { animate: true, duration: .18 });
  render();
}

function markSaved() {
  if (savedAtEl) savedAtEl.textContent = `Последнее сохранение: ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('keydown', (event) => {
  if (event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  const controls = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
  const direction = controls[event.key] || controls[event.key.toLowerCase()];
  if (direction) { event.preventDefault(); move(...direction); }
});
document.querySelector('#locate').addEventListener('click', () => {
  player.lat = start[0]; player.lng = start[1];
  map.setView(start, 14);
  render();
});
document.querySelector('#zoom-in').addEventListener('click', () => {
  map.zoomIn();
  zoomPercent = Math.min(135, zoomPercent + 10);
  document.querySelector('#zoom-level').textContent = `${zoomPercent}%`;
});
document.querySelector('#zoom-out').addEventListener('click', () => {
  map.zoomOut();
  zoomPercent = Math.max(80, zoomPercent - 10);
  document.querySelector('#zoom-level').textContent = `${zoomPercent}%`;
});
map.on('move zoom resize', () => render());
map.on('click', (event) => {
  player.lat = event.latlng.lat;
  player.lng = event.latlng.lng;
  map.panTo(event.latlng, { animate: true, duration: .18 });
  render();
});
window.addEventListener('resize', drawFog);

const exportButton = document.querySelector('#export-fog');
const importInput = document.querySelector('#import-fog');
const resetButton = document.querySelector('#reset-fog');
if (exportButton) {
  exportButton.addEventListener('click', () => {
    downloadText(`terra-incognita-${new Date().toISOString().slice(0, 10)}.json`, fog.exportJSON());
  });
}
if (importInput) {
  importInput.addEventListener('change', () => {
    const file = importInput.files && importInput.files[0];
    if (!file) return;
    file.text().then((text) => {
      const count = fog.importJSON(text);
      if (savedAtEl) savedAtEl.textContent = `Импортировано чанков: ${count}`;
      updateProgress();
      drawFog();
    }).catch((error) => {
      if (savedAtEl) savedAtEl.textContent = `Импорт не удался: ${error.message}`;
    }).finally(() => { importInput.value = ''; });
  });
}
if (resetButton) {
  resetButton.addEventListener('click', () => {
    if (!window.confirm('Стереть всё открытое? Это действие нельзя отменить.')) return;
    fog.clear().then(() => {
      revealSpots.length = 0;
      lastRevealKey = '';
      localStorage.removeItem(POI_KEY);
      pointsOfInterest.forEach((poi) => { poi.discovered = poi.id === 'camp'; });
      discoveryList.querySelectorAll('.discovery').forEach((entry) => {
        if (entry.dataset.poi === 'camp') return;
        entry.classList.remove('found');
        const icon = entry.querySelector('.discovery-icon');
        const mark = entry.querySelector('i');
        if (icon) icon.textContent = '?';
        if (mark) mark.textContent = '·';
      });
      updateProgress();
      render(false);
      if (savedAtEl) savedAtEl.textContent = 'Открытые области стёрты';
    });
  });
}

function clock() { document.querySelector('#clock').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
clock();
setInterval(clock, 60000);

fog.onSaved = markSaved;
fog.ready.then(() => {
  updateProgress();
  render(false);
  if (savedAtEl) savedAtEl.textContent = fog.totalCells ? `Загружено: ${fog.chunks.size} чанк(ов)` : 'Последнее сохранение: ещё не было';
});
