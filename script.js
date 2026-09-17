const start = [48.8566, 2.3522];
const player = { lat: start[0], lng: start[1] };
const moveStepMeters = 30;
const revealRadiusMeters = 30;
const visited = new Set();
const revealSpots = new Map();
let animationFrame = null;
let zoomPercent = 100;

const mapViewport = document.querySelector('#map-viewport');
const playerEl = document.querySelector('#player');
const fogCanvas = document.querySelector('#fog-canvas');
const progressBar = document.querySelector('#progress-bar');
const progressValue = document.querySelector('#progress-value');
const progressCaption = document.querySelector('#progress-caption');
const coordinates = document.querySelector('#coordinates');
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView(start, 14);
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

function key(lat, lng) {
  return `${Math.round(lat * 7400)},${Math.round(lng * 5000)}`;
}

function metersToLatitude(meters) {
  return meters / 111320;
}

function metersToLongitude(meters, lat) {
  return meters / (111320 * Math.max(.01, Math.cos(lat * Math.PI / 180)));
}

function radiusInPixels(lat, lng, meters) {
  const center = map.latLngToContainerPoint([lat, lng]);
  const edge = map.latLngToContainerPoint([lat, lng + metersToLongitude(meters, lat)]);
  return Math.max(4, Math.abs(edge.x - center.x));
}

function drawFog() {
  const bounds = mapViewport.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const theme = document.documentElement.dataset.theme || 'terra';
  fogCanvas.width = bounds.width * ratio;
  fogCanvas.height = bounds.height * ratio;
  maskCanvas.width = fogCanvas.width;
  maskCanvas.height = fogCanvas.height;
  fogContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  maskContext.setTransform(ratio, 0, 0, ratio, 0, 0);
  maskContext.clearRect(0, 0, bounds.width, bounds.height);
  fogContext.globalCompositeOperation = 'source-over';
  fogContext.fillStyle = fogColors[theme];
  fogContext.fillRect(0, 0, bounds.width, bounds.height);
  drawFogTexture(bounds, theme);
  const now = performance.now();
  let animating = false;
  revealSpots.forEach((spot) => {
    const point = map.latLngToContainerPoint([spot.lat, spot.lng]);
    const radius = radiusInPixels(spot.lat, spot.lng, revealRadiusMeters);
    const progress = Math.min(1, (now - spot.createdAt) / spot.duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    if (progress < 1) animating = true;
    if (theme === 'heroes') {
      drawHeroesReveal(point, radius, eased);
    } else if (theme === 'western') {
      drawWesternReveal(point, radius, spot.id, eased);
    } else {
      drawTerraReveal(point, radius, eased);
    }
  });
  fogContext.globalCompositeOperation = 'destination-out';
  fogContext.drawImage(maskCanvas, 0, 0, bounds.width, bounds.height);
  fogContext.globalCompositeOperation = 'source-over';
  animationFrame = null;
  if (animating) queueFogAnimation();
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

function render() {
  const point = map.latLngToContainerPoint([player.lat, player.lng]);
  playerEl.style.left = `${point.x}px`;
  playerEl.style.top = `${point.y}px`;
  coordinates.textContent = `${Math.abs(player.lat).toFixed(3)}° N   ${Math.abs(player.lng).toFixed(3)}° E`;
  const locationKey = key(player.lat, player.lng);
  if (!visited.has(locationKey)) {
    visited.add(locationKey);
    const theme = document.documentElement.dataset.theme || 'terra';
    revealSpots.set(locationKey, { id: locationKey, lat: player.lat, lng: player.lng, createdAt: performance.now(), duration: theme === 'heroes' ? 180 : 760 });
    const percentage = Math.min(86, 12 + Math.round((visited.size - 1) * 2.7));
    progressBar.style.width = `${percentage}%`;
    progressValue.textContent = `${percentage}%`;
    progressCaption.textContent = percentage > 70 ? 'Большая часть сектора изучена' : percentage > 35 ? 'Следы ведут всё дальше' : 'Путь только начинается';
  }
  queueFogAnimation();
}

function move(dx, dy) {
  player.lat -= dy * metersToLatitude(moveStepMeters);
  player.lng += dx * metersToLongitude(moveStepMeters, player.lat);
  map.panTo([player.lat, player.lng], { animate: true, duration: .18 });
  render();
}

document.addEventListener('keydown', (event) => {
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
map.on('move zoom resize', render);
map.on('click', (event) => {
  player.lat = event.latlng.lat;
  player.lng = event.latlng.lng;
  map.panTo(event.latlng, { animate: true, duration: .18 });
  render();
});
window.addEventListener('resize', drawFog);
function clock() { document.querySelector('#clock').textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
clock();
setInterval(clock, 60000);
render();
