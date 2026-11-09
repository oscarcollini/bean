'use strict';

const $ = id => document.getElementById(id);
const audio = $('audio');
const interval = 30 * 60 * 1000;
const storageKey = 'bean-library-v1';
let state = { shows: [], current: null, rate: 1 };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Array.isArray(saved.shows)) state = saved;
} catch {
  // An unreadable library starts empty.
}

let filter = null;
let refreshing = false;
let resumeAt = 0;
let lastSavedPosition = 0;

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    status('Memoria locale piena o indisponibile.');
  }
}

function status(message = '') {
  $('status').textContent = message;
  $('status').hidden = !message;
}

let searchSequence = 0;

function searchPodcasts(term) {
  return new Promise((resolve, reject) => {
    const callback = 'beanCatalog' + ++searchSequence;
    const script = document.createElement('script');
    const url = new URL('https://itunes.apple.com/search');
    url.search = new URLSearchParams({
      term, country: 'IT', media: 'podcast', entity: 'podcast', limit: '25', callback
    });
    function finish(error, data) {
      clearTimeout(timeout);
      script.remove();
      delete window[callback];
      if (error) reject(error);
      else resolve(data);
    }
    const timeout = setTimeout(() => finish(new Error('Catalogo non raggiungibile')), 12000);
    window[callback] = data => {
      if (!Array.isArray(data?.results)) {
        finish(new Error('Risposta del catalogo non valida'));
        return;
      }
      const matches = data.results
        .filter(item => /^https?:\/\//i.test(item.feedUrl || ''))
        .map(item => ({
          title: item.collectionName || item.trackName || 'Podcast',
          author: item.artistName || '',
          feed: item.feedUrl
        }));
      finish(null, matches);
    };
    script.src = url.href;
    script.onerror = () => finish(new Error('Catalogo non raggiungibile'));
    document.head.append(script);
  });
}

async function feedResponse(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000), credentials: 'omit', referrerPolicy: 'no-referrer'
  });
  if (!response.ok) throw new Error('Feed non raggiungibile');
  return response;
}

async function readEpisodes(feed) {
  const source = new URL(feed);
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new Error('Indirizzo del feed non valido');
  }
  if (source.protocol === 'https:') {
    try {
      const response = await feedResponse(source);
      return parseFeed(new Uint8Array(await response.arrayBuffer()), response.url || source.href);
    } catch {
      // Many podcast hosts do not allow cross-origin requests from browsers.
    }
  }
  const proxy = new URL('https://api.codetabs.com/v1/proxy');
  proxy.searchParams.set('quest', source.href);
  const response = await feedResponse(proxy);
  return parseFeed(new Uint8Array(await response.arrayBuffer()), source.href);
}

function textOf(element, name) {
  return [...element.children].find(child => child.localName === name)?.textContent.trim() || '';
}

function parseFeed(bytes, baseUrl) {
  const prefix = new TextDecoder().decode(bytes.slice(0, 256));
  const encoding = prefix.match(/encoding\s*=\s*['"]([^'"]+)/i)?.[1];
  const utf16 = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : null;
  const xml = new TextDecoder(utf16 || encoding || 'utf-8').decode(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !['rss', 'feed', 'RDF'].includes(doc.documentElement.localName)) {
    throw new Error('Feed non valido');
  }
  return [...doc.getElementsByTagNameNS('*', '*')]
    .filter(item => ['item', 'entry'].includes(item.localName))
    .slice(0, 150)
    .flatMap(item => {
      const enclosure = [...item.children].find(child =>
        child.localName === 'enclosure' ||
        (child.localName === 'link' && child.getAttribute('rel') === 'enclosure'));
      const source = enclosure?.getAttribute('url') || enclosure?.getAttribute('href');
      if (!source) return [];
      try {
        const url = new URL(source, baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return [];
        if (location.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
        return [{
          id: (textOf(item, 'guid') || textOf(item, 'id') || url.href).slice(0, 600),
          title: (textOf(item, 'title') || 'Puntata').slice(0, 300),
          date: Date.parse(textOf(item, 'pubDate') || textOf(item, 'published') || textOf(item, 'updated')) || 0,
          url: url.href
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, 30);
}

function row(title, subtitle) {
  const item = document.createElement('li');
  const labels = document.createElement('div');
  const name = document.createElement('strong');
  const detail = document.createElement('small');
  name.textContent = title;
  detail.textContent = subtitle;
  labels.append(name, detail);
  item.append(labels);
  return item;
}

function button(parent, label, action, accessibleLabel = label) {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  control.setAttribute('aria-label', accessibleLabel);
  control.addEventListener('click', () => action(control));
  parent.append(control);
}

function empty(list, message) {
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = message;
  list.append(item);
}

function render() {
  const following = $('following');
  const episodes = $('episodes');
  following.replaceChildren();
  episodes.replaceChildren();
  const selected = state.shows.find(show => show.feed === filter);
  $('episode-heading').textContent = selected?.title || 'Ultime puntate';
  $('all').hidden = !selected;

  if (!state.shows.length) {
    empty(following, 'Cerca un podcast e premi Segui.');
    empty(episodes, 'Le nuove puntate dei tuoi podcast compariranno qui.');
    return;
  }

  for (const show of state.shows) {
    const item = row(show.title, show.author);
    button(item, 'Puntate', () => {
      filter = show.feed;
      render();
      $('episode-heading').scrollIntoView({ block: 'start' });
    }, 'Puntate di ' + show.title);
    button(item, '×', () => {
      state.shows = state.shows.filter(candidate => candidate !== show);
      if (filter === show.feed) filter = null;
      save();
      render();
    }, 'Smetti di seguire ' + show.title);
    following.append(item);
  }

  const combined = (selected ? [selected] : state.shows)
    .flatMap(show => show.episodes.map(episode => ({ ...episode, show: show.title, feed: show.feed })))
    .sort((a, b) => b.date - a.date)
    .slice(0, 60);
  if (!combined.length) empty(episodes, 'Nessuna puntata disponibile.');
  for (const episode of combined) {
    const date = episode.date ? new Date(episode.date).toLocaleDateString('it-IT') : '';
    const item = row(episode.title, [episode.show, date].filter(Boolean).join(' · '));
    button(item, 'Ascolta', () => openEpisode(episode), 'Ascolta ' + episode.title);
    episodes.append(item);
  }
}

async function updateShows(manual = false, startup = false) {
  if (refreshing) return;
  const shows = state.shows.filter(show => manual || startup || Date.now() - (show.checked || 0) >= interval);
  if (!shows.length) {
    if (manual) status('Segui un podcast per aggiornare le puntate.');
    return;
  }
  refreshing = true;
  $('refresh').disabled = true;
  if (manual) status('Aggiorno le puntate…');
  let failures = 0;
  try {
    for (const show of shows) {
      try {
        show.episodes = await readEpisodes(show.feed);
      } catch {
        failures++;
      }
      show.checked = Date.now();
      save();
      render();
    }
    if (manual || failures) {
      status(failures ? `Feed non raggiungibili: ${failures} su ${shows.length}.` : 'Puntate aggiornate.');
    }
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
  }
}

$('search').addEventListener('submit', async event => {
  event.preventDefault();
  const q = $('query').value.trim();
  if (!q) return;
  const submit = $('search').querySelector('button');
  submit.disabled = true;
  status('Cerco nel catalogo…');
  $('results-section').hidden = true;
  const results = $('results');
  results.replaceChildren();
  try {
    const matches = await searchPodcasts(q);
    if (!matches.length) empty(results, 'Nessun podcast trovato.');
    for (const match of matches) {
      const item = row(match.title, match.author);
      const followed = state.shows.some(show => show.feed === match.feed);
      button(item, followed ? 'Seguito' : 'Segui', async control => {
        if (state.shows.some(show => show.feed === match.feed)) return;
        control.disabled = true;
        status('Carico le puntate…');
        try {
          const episodes = await readEpisodes(match.feed);
          state.shows.push({ ...match, episodes, checked: Date.now() });
          save();
          render();
          control.textContent = 'Seguito';
          status();
        } catch {
          control.disabled = false;
          status('Non riesco a leggere il feed di questo podcast.');
        }
      });
      item.querySelector('button').disabled = followed;
      results.append(item);
    }
    $('results-section').hidden = false;
    status();
  } catch {
    status('Ricerca non disponibile. Riprova tra poco.');
  } finally {
    submit.disabled = false;
  }
});

$('close-results').onclick = () => { $('results-section').hidden = true; };
$('refresh').onclick = () => updateShows(true);
$('all').onclick = () => { filter = null; render(); };

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const tail = String(total % 60).padStart(2, '0');
  return minutes < 60 ? `${minutes}:${tail}` :
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`;
}

function rememberPosition() {
  if (!state.current || audio.readyState === 0) return;
  lastSavedPosition = audio.currentTime;
  state.current.position = lastSavedPosition;
  save();
}

function showAudioError(message = '') {
  $('audio-error').textContent = message;
  $('audio-error').hidden = !message;
}

function play() {
  showAudioError();
  audio.play().catch(error => {
    if (error.name !== 'AbortError') showAudioError('Riproduzione non disponibile. Tocca Play per riprovare.');
  });
}

function openEpisode(episode, autoplay = true) {
  const same = state.current?.feed === episode.feed && state.current?.id === episode.id;
  if (same && audio.hasAttribute('src')) {
    if (autoplay) play();
    return;
  }

  resumeAt = same ? state.current.position || 0 : 0;
  lastSavedPosition = resumeAt;
  state.current = { ...episode, position: resumeAt };
  save();
  $('player').hidden = false;
  $('playing-title').textContent = episode.title;
  $('playing-show').textContent = episode.show;
  showAudioError();
  audio.src = episode.url;
  audio.playbackRate = Number($('rate').value);
  updateTimeline();
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: episode.show,
      artwork: [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
    });
  }
  if (autoplay) play();
}

function seek(position) {
  if (!Number.isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, position));
  updateTimeline();
  rememberPosition();
}

function updateTimeline() {
  const ready = audio.readyState > 0 && Number.isFinite(audio.duration) && audio.duration > 0;
  const current = ready ? audio.currentTime : resumeAt;
  $('position').disabled = !ready;
  $('position').max = ready ? audio.duration : 1;
  $('position').value = ready ? current : 0;
  $('elapsed').textContent = clock(current);
  $('duration').textContent = ready ? clock(audio.duration) : '–:––';
  if (ready && navigator.mediaSession?.setPositionState) {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.duration, current)
    });
  }
}

$('toggle').onclick = () => { if (audio.paused) play(); else audio.pause(); };
$('back').onclick = () => seek(audio.currentTime - 10);
$('forward').onclick = () => seek(audio.currentTime + 30);
$('position').oninput = event => seek(Number(event.target.value));
$('rate').value = String(state.rate) === '0.75' ? '.75' : String(state.rate);
if (!$('rate').value) $('rate').value = '1';
$('rate').onchange = () => {
  state.rate = Number($('rate').value);
  audio.playbackRate = state.rate;
  save();
  updateTimeline();
};

audio.addEventListener('loadedmetadata', () => {
  if (resumeAt && Number.isFinite(audio.duration) && resumeAt < audio.duration - 2) {
    audio.currentTime = resumeAt;
  }
  resumeAt = 0;
  updateTimeline();
});
audio.addEventListener('durationchange', updateTimeline);
audio.addEventListener('timeupdate', () => {
  updateTimeline();
  if (Math.abs(audio.currentTime - lastSavedPosition) >= 5) rememberPosition();
});
for (const event of ['play', 'pause', 'ended']) {
  audio.addEventListener(event, () => {
    $('toggle').textContent = audio.paused ? 'Play' : 'Pausa';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    if (event !== 'play') rememberPosition();
  });
}
audio.addEventListener('error', () => showAudioError('Audio non disponibile per questa puntata.'));

if ('mediaSession' in navigator) {
  const actions = {
    play: () => { if (state.current) play(); },
    pause: () => audio.pause(),
    seekbackward: () => seek(audio.currentTime - 10),
    seekforward: () => seek(audio.currentTime + 30),
    seekto: ({ seekTime }) => seek(seekTime)
  };
  for (const [action, handler] of Object.entries(actions)) {
    try { navigator.mediaSession.setActionHandler(action, handler); }
    catch { /* Action unsupported on this device. */ }
  }
}

render();
if (state.current) openEpisode(state.current, false);
updateShows(false, true);
setInterval(() => { if (!document.hidden) updateShows(); }, interval);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) rememberPosition();
  else updateShows();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
