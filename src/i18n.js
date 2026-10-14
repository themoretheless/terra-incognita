// @ts-check
/**
 * Локализация RU/EN. Элементы с data-i18n="ключ" получают текст,
 * data-i18n-attr="aria-label:ключ;title:ключ" — атрибуты.
 */

/** @type {Record<string, Record<string, string>>} */
export const DICT = {
  ru: {
    'app.title': 'Terra Incognita — карта путешественника',
    'status.active': 'Экспедиция активна',
    'theme.label': 'Стиль экспедиции',
    'intro.eyebrow': 'Журнал экспедиции · день {day}',
    'intro.title1': 'Откройте мир',
    'intro.title2': 'своими шагами.',
    'intro.copy': 'За туманом скрывается неизвестное. Исследуйте каждый уголок карты — новые места проявятся, когда вы окажетесь рядом.',
    'map.sector': 'Сектор',
    'map.name': '{area} · радиус {radius} м',
    'map.hint': 'Перемещайтесь по карте или используйте',
    'map.zoomIn': 'Увеличить масштаб',
    'map.zoomOut': 'Уменьшить масштаб',
    'map.aria': 'Интерактивная карта экспедиции',
    'progress.title': 'Открытая территория',
    'progress.start': 'Путь только начинается',
    'progress.mid': 'Следы ведут всё дальше',
    'progress.late': 'Большая часть изучена',
    'progress.of': 'от «{area}»',
    'progress.sector': 'от квадратного километра вокруг старта',
    'today.title': 'Сегодня',
    'today.cells': '+{today} клеток · неделя +{week}',
    'position.title': 'Текущая позиция',
    'pois.title': 'Найдено объектов',
    'pois.distance': 'Расстояние: {d}',
    'pois.found': 'Обнаружено',
    'pois.loading': 'Ищу интересные места…',
    'quest.title': 'Цель',
    'quest.none': 'Все цели рядом найдены',
    'quest.go': 'Идите на {dir}, {d}',
    'hint.nearest': 'Ближайшее неразведанное: {dir}, {d}',
    level: 'Уровень {level}',
    xp: '{xp} / {next} опыта',
    locate: 'Вернуться к лагерю',
    center: 'Ко мне',
    'gps.on': 'GPS включён',
    'gps.off': 'GPS выключен',
    'gps.weak': 'Слабый сигнал GPS',
    'gps.search': 'Ищу спутники…',
    saved: 'Сохранено {time}',
    'saved.never': 'Ещё не сохранялось',
    'saved.loaded': 'Загружено чанков: {n}',
    'menu.settings': 'Настройки',
    'menu.stats': 'Статистика',
    'menu.journal': 'Журнал',
    'menu.data': 'Данные',
    'menu.help': 'Клавиши',
    'menu.share': 'Поделиться',
    'menu.timeline': 'Хроника',
    'export.done': 'Экспорт готов · {size}',
    'export.fail': 'Экспорт не удался: {error}',
    'import.done': 'Импортировано чанков: {n}',
    'import.fail': 'Импорт не удался: {error}',
    'import.undo': 'Отменить',
    'import.undone': 'Импорт отменён',
    'reset.title': 'Стереть всё открытое?',
    'reset.text': 'Это действие нельзя отменить. Чтобы подтвердить, введите слово «{word}».',
    'reset.word': 'стереть',
    'reset.done': 'Открытые области стёрты',
    cancel: 'Отмена',
    confirm: 'Подтвердить',
    close: 'Закрыть',
    achievement: 'Достижение: {name}',
    'tiles.error': 'Тайлы карты не загружаются. Пелена и сохранение работают, подложка вернётся при появлении сети.',
    'storage.persisted': 'Хранилище защищено от очистки',
    'loading.chunks': 'Подгружаю карту…',
    'onboarding.1.title': 'Добро пожаловать в Terra Incognita',
    'onboarding.1.text': 'Карта скрыта туманом. Он рассеивается там, где вы побывали, — и запоминается навсегда.',
    'onboarding.2.title': 'Как двигаться',
    'onboarding.2.text': 'Клавиши WASD или стрелки, клик по карте — или включите GPS в настройках и просто гуляйте.',
    'onboarding.3.title': 'Цели и стиль',
    'onboarding.3.text': 'Справа — прогресс, цели и находки. Стиль пелены и интерфейса меняется в настройках. Клавиша ? покажет все сочетания.',
    next: 'Дальше',
    start: 'Начать'
  },
  en: {
    'app.title': 'Terra Incognita — explorer map',
    'status.active': 'Expedition active',
    'theme.label': 'Expedition style',
    'intro.eyebrow': 'Expedition log · day {day}',
    'intro.title1': 'Uncover the world',
    'intro.title2': 'one step at a time.',
    'intro.copy': 'The unknown hides behind the fog. Explore every corner — places reveal themselves once you are near.',
    'map.sector': 'Sector',
    'map.name': '{area} · radius {radius} m',
    'map.hint': 'Move around the map or use',
    'map.zoomIn': 'Zoom in',
    'map.zoomOut': 'Zoom out',
    'map.aria': 'Interactive expedition map',
    'progress.title': 'Explored territory',
    'progress.start': 'The journey begins',
    'progress.mid': 'The trail leads further',
    'progress.late': 'Most of it is explored',
    'progress.of': 'of “{area}”',
    'progress.sector': 'of a square kilometre around the start',
    'today.title': 'Today',
    'today.cells': '+{today} cells · week +{week}',
    'position.title': 'Current position',
    'pois.title': 'Places found',
    'pois.distance': 'Distance: {d}',
    'pois.found': 'Discovered',
    'pois.loading': 'Looking for interesting places…',
    'quest.title': 'Goal',
    'quest.none': 'All nearby goals found',
    'quest.go': 'Head {dir}, {d}',
    'hint.nearest': 'Nearest unexplored: {dir}, {d}',
    level: 'Level {level}',
    xp: '{xp} / {next} XP',
    locate: 'Back to camp',
    center: 'Find me',
    'gps.on': 'GPS on',
    'gps.off': 'GPS off',
    'gps.weak': 'Weak GPS signal',
    'gps.search': 'Searching satellites…',
    saved: 'Saved {time}',
    'saved.never': 'Not saved yet',
    'saved.loaded': 'Chunks loaded: {n}',
    'menu.settings': 'Settings',
    'menu.stats': 'Stats',
    'menu.journal': 'Journal',
    'menu.data': 'Data',
    'menu.help': 'Keys',
    'menu.share': 'Share',
    'menu.timeline': 'Timeline',
    'export.done': 'Export ready · {size}',
    'export.fail': 'Export failed: {error}',
    'import.done': 'Chunks imported: {n}',
    'import.fail': 'Import failed: {error}',
    'import.undo': 'Undo',
    'import.undone': 'Import undone',
    'reset.title': 'Erase everything explored?',
    'reset.text': 'This cannot be undone. Type “{word}” to confirm.',
    'reset.word': 'erase',
    'reset.done': 'Explored areas erased',
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    achievement: 'Achievement: {name}',
    'tiles.error': 'Map tiles fail to load. Fog and saving still work; the base map returns when the network does.',
    'storage.persisted': 'Storage is protected from eviction',
    'loading.chunks': 'Loading map…',
    'onboarding.1.title': 'Welcome to Terra Incognita',
    'onboarding.1.text': 'The map is hidden by fog. It clears where you have been — and stays clear forever.',
    'onboarding.2.title': 'How to move',
    'onboarding.2.text': 'WASD or arrow keys, click the map — or turn on GPS in settings and just walk.',
    'onboarding.3.title': 'Goals and style',
    'onboarding.3.text': 'Progress, goals and finds are on the right. Fog and interface style live in settings. Press ? for all shortcuts.',
    next: 'Next',
    start: 'Start'
  }
};

let lang = 'ru';

/** @param {string} value */
export function setLang(value) {
  lang = DICT[value] ? value : 'ru';
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

export function getLang() {
  return lang;
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 */
export function t(key, params = {}) {
  const template = (DICT[lang] && DICT[lang][key]) || DICT.ru[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (params[name] !== undefined ? String(params[name]) : `{${name}}`));
}

/** Применяет переводы к разметке. @param {ParentNode} [root] */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(/** @type {string} */ (el.getAttribute('data-i18n')));
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    String(el.getAttribute('data-i18n-attr'))
      .split(';')
      .forEach((pair) => {
        const [attr, key] = pair.split(':');
        if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
      });
  });
  if (typeof document !== 'undefined') document.title = t('app.title');
}

/** Форматирование расстояния. @param {number} meters */
export function formatDistance(meters) {
  if (lang === 'en') return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} км` : `${Math.round(meters)} м`;
}

/** Форматирование площади. @param {number} sqm */
export function formatArea(sqm) {
  const ha = sqm / 10000;
  if (lang === 'en') return ha >= 100 ? `${(ha / 100).toFixed(2)} km²` : `${ha.toFixed(2)} ha`;
  return ha >= 100 ? `${(ha / 100).toFixed(2)} км²` : `${ha.toFixed(2)} га`;
}

/** Сторона света по азимуту. @param {number} deg */
export function compassDirection(deg) {
  const ru = ['север', 'северо-восток', 'восток', 'юго-восток', 'юг', 'юго-запад', 'запад', 'северо-запад'];
  const en = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const i = Math.round(deg / 45) % 8;
  return (lang === 'en' ? en : ru)[i];
}
