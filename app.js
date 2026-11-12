'use strict';

const beanLocale = globalThis.appLocale ?? {
  locale: 'it-IT',
  text: (source, ...values) => source.replace(/\{(\d+)\}/g, (_, index) => values[index])
};

(() => {
  const panel = document.getElementById('beanInstallPanel');
  const button = document.getElementById('beanInstallButton');
  const status = document.getElementById('beanInstallStatus');
  const appMode = matchMedia('(display-mode: standalone)');
  let installPrompt = null;
  let installedHere = false;

  function updatePanel() {
    panel.hidden = installedHere || appMode.matches || navigator.standalone === true;
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    status.textContent = '';
  });
  window.addEventListener('appinstalled', () => {
    installedHere = true;
    installPrompt = null;
    updatePanel();
  });
  appMode.addEventListener('change', updatePanel);
  updatePanel();

  button.addEventListener('click', async () => {
    const prompt = installPrompt;
    if (!prompt) {
      status.textContent = beanLocale.text('In Chrome apri il menu ⋮ e scegli «Aggiungi a schermata Home» o «Installa app», se disponibile.');
      return;
    }
    installPrompt = null;
    button.disabled = true;
    status.textContent = '';
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') {
        installedHere = true;
        updatePanel();
      }
    } catch {
      status.textContent = beanLocale.text('Il browser non ha aperto la richiesta. Riprova dal menu ⋮.');
    } finally {
      button.disabled = false;
    }
  });
})();


const $ = id => document.getElementById(id);
const audio = $('audio');
const pageSize = 30;
const episodeCatalogs = new Map();
const visibleEpisodes = new Map();
const visibleArchived = new Map();
const loadingOlder = new Set();
const interval = 30 * 60 * 1000;
const storageKey = 'bean-library-v1';
let state = { shows: [], current: null, rate: 1 };
let storageReadable = true;
let restoring = false;
try {
  const raw = localStorage.getItem(storageKey);
  if (raw !== null) {
    const saved = JSON.parse(raw);
    if (!saved || !Array.isArray(saved.shows)) throw new Error('Invalid podcast library');
    state = saved;
  }
} catch {
  storageReadable = false;
}

state.listening ??= {};
state.queue ??= [];
if (state.current?.position > 0) {
  state.listening[episodeKey(state.current)] ??= state.current;
}
let refreshing = false;
let resumeAt = 0;
let lastSavedPosition = 0;
let replayingArchived = false;

function storeLibrary(library) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(library));
  } catch {
    throw new Error(beanLocale.text('Memoria locale piena o indisponibile.'));
  }
}

function save() {
  if (!storageReadable || restoring) return;
  try {
    storeLibrary(state);
  } catch (error) {
    status(error.message);
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
    const timeout = setTimeout(() => finish(new Error(beanLocale.text('Catalogo non raggiungibile'))), 12000);
    window[callback] = data => {
      if (!Array.isArray(data?.results)) {
        finish(new Error(beanLocale.text('Risposta del catalogo non valida')));
        return;
      }
      const matches = data.results
        .filter(item => /^https?:\/\//i.test(item.feedUrl || ''))
        .map(item => ({
          title: item.collectionName || item.trackName || 'Podcast',
          author: item.artistName || '',
          artwork: artworkUrl(item.artworkUrl600 || item.artworkUrl100),
          feed: item.feedUrl
        }));
      finish(null, matches);
    };
    script.src = url.href;
    script.onerror = () => finish(new Error(beanLocale.text('Catalogo non raggiungibile')));
    document.head.append(script);
  });
}

async function feedResponse(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000), credentials: 'omit', referrerPolicy: 'no-referrer'
  });
  if (!response.ok) throw new Error(beanLocale.text('Feed non raggiungibile'));
  return response;
}

function spreakerNextPage(nextUrl, currentUrl) {
  const next = webLink(nextUrl);
  if (!next) return '';
  const url = new URL(next);
  return url.origin === currentUrl.origin && url.pathname === currentUrl.pathname &&
    url.href !== currentUrl.href ? url.href : '';
}

async function readSpreakerEpisodes(url) {
  const response = await feedResponse(url);
  const { response: show } = await response.json();
  if (!Array.isArray(show?.items)) throw new Error(beanLocale.text('Risposta Spreaker non valida'));
  const episodes = show.items.flatMap(item => {
    const id = String(item.episode_id || '');
    const playback = item.playback_url;
    if (!/^\d+$/.test(id) || typeof playback !== 'string') return [];
    const audio = new URL(playback);
    if (audio.protocol !== 'https:' || audio.username || audio.password) return [];
    // Match the GUID in Spreaker's RSS so archives, progress and novelty survive.
    return [{
      id: 'https://api.spreaker.com/episode/' + id,
      title: String(item.title || beanLocale.text('Puntata')).slice(0, 300),
      date: Date.parse(String(item.published_at || '').replace(' ', 'T') + 'Z') || 0,
      url: audio.href,
      notes: String(item.description || '').slice(0, 32000),
      link: webLink(item.site_url || item.permalink, url.href)
    }];
  }).sort((a, b) => b.date - a.date);
  return { episodes, artwork: '', nextPage: spreakerNextPage(show.next_url, url) };
}

async function readEpisodes(feed) {
  const source = new URL(feed);
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) {
    throw new Error(beanLocale.text('Indirizzo del feed non valido'));
  }
  const spreakerId = ['www.spreaker.com', 'spreaker.com'].includes(source.hostname) &&
    source.pathname.match(/^\/show\/(\d+)\/episodes\/feed\/?$/)?.[1];
  if (spreakerId) {
    try {
      const url = new URL('https://api.spreaker.com/v2/shows/' + spreakerId + '/episodes');
      url.searchParams.set('sorting', 'newest');
      url.searchParams.set('limit', String(pageSize));
      const feed = await readSpreakerEpisodes(url);
      if (feed.episodes.length || feed.nextPage) return feed;
    } catch {
      // The publisher's RSS remains available as a fallback.
    }
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

function webLink(source, baseUrl) {
  if (typeof source !== 'string' || !source.trim()) return '';
  try {
    const url = new URL(source, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function artworkUrl(source, baseUrl) {
  if (!source) return '';
  try {
    const url = new URL(source, baseUrl);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function cover(source, lazy = true) {
  const img = document.createElement('img');
  img.className = 'cover';
  img.alt = '';
  img.loading = lazy ? 'lazy' : 'eager';
  setCover(img, source);
  return img;
}

function setCover(img, source) {
  const fallback = new URL('icon.svg', location.href).href;
  img.onerror = () => { if (img.src !== fallback) img.src = fallback; };
  img.referrerPolicy = 'no-referrer';
  img.src = artworkUrl(source) || fallback;
}

function parseFeed(bytes, baseUrl) {
  const prefix = new TextDecoder().decode(bytes.slice(0, 256));
  const encoding = prefix.match(/encoding\s*=\s*['"]([^'"]+)/i)?.[1];
  const utf16 = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
    : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : null;
  const xml = new TextDecoder(utf16 || encoding || 'utf-8').decode(bytes);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || !['rss', 'feed', 'RDF'].includes(doc.documentElement.localName)) {
    throw new Error(beanLocale.text('Feed non valido'));
  }
  const root = doc.documentElement;
  const channel = [...root.children].find(child => child.localName === 'channel') || root;
  const image = [...channel.children].find(child => child.localName === 'image' && child.hasAttribute('href'));
  const standardImage = [...channel.children].find(child => child.localName === 'image' && !child.namespaceURI);
  const artwork = artworkUrl(image?.getAttribute('href') ||
    (standardImage && textOf(standardImage, 'url')) || textOf(channel, 'logo') || textOf(channel, 'icon'), baseUrl);
  const episodes = [...doc.getElementsByTagNameNS('*', '*')]
    .filter(item => ['item', 'entry'].includes(item.localName))
    .flatMap(item => {
      const enclosure = [...item.children].find(child =>
        child.localName === 'enclosure' ||
        (child.localName === 'link' && child.getAttribute('rel') === 'enclosure'));
      const source = enclosure?.getAttribute('url') || enclosure?.getAttribute('href');
      const page = [...item.children].find(child => child.localName === 'link' &&
        (!child.hasAttribute('rel') || child.getAttribute('rel') === 'alternate'));
      if (!source) return [];
      try {
        const url = new URL(source, baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return [];
        if (location.protocol === 'https:' && url.protocol === 'http:') url.protocol = 'https:';
        return [{
          id: (textOf(item, 'guid') || textOf(item, 'id') || url.href).slice(0, 600),
          title: (textOf(item, 'title') || beanLocale.text('Puntata')).slice(0, 300),
          date: Date.parse(textOf(item, 'pubDate') || textOf(item, 'published') || textOf(item, 'updated')) || 0,
          url: url.href,
          notes: (textOf(item, 'encoded') || textOf(item, 'description') ||
            textOf(item, 'content') || textOf(item, 'summary')).slice(0, 32000),
          link: webLink(page?.getAttribute('href') || page?.textContent, baseUrl)
        }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.date - a.date);
  return { episodes, artwork };
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

function episodeKey({ feed, id }) {
  return JSON.stringify([feed, id]);
}

function isBeforeArchiveCutoff(episode, cutoff) {
  return episode.date > 0 && episode.date <= cutoff;
}

function isListened(episode, show = state.shows.find(show => show.feed === episode.feed)) {
  const entry = state.listening[episodeKey(episode)];
  return Boolean(entry?.listened ||
    (!entry?.restored && isBeforeArchiveCutoff(episode, show?.archiveThrough)));
}

let undoTimer;
let undoAction;
const undoBar = $('undo-bar');
const listeningDialog = $('listening-dialog');
const player = $('player');

new ResizeObserver(() => {
  document.documentElement.style.setProperty('--player-height', player.offsetHeight + 'px');
}).observe(player);

function clearUndo() {
  clearTimeout(undoTimer);
  undoBar.hidden = true;
  undoAction = undefined;
}

function offerUndo(message, action) {
  clearUndo();
  (listeningDialog.open ? listeningDialog : document.body).append(undoBar);
  $('undo-message').textContent = message;
  undoBar.hidden = false;
  undoAction = action;
  undoTimer = setTimeout(clearUndo, 5000);
}

listeningDialog.addEventListener('close', () => document.body.append(undoBar));
$('undo-button').onclick = () => {
  const action = undoAction;
  clearUndo();
  action?.();
};

function archiveWithUndo(episode, message, apply, reopenPlayer = false) {
  const show = state.shows.find(show => show.feed === episode.feed);
  const cutoff = show?.archiveThrough;
  const newIds = [...(show?.newIds || [])];
  const queue = [...state.queue];
  const before = { ...state.listening };
  const current = state.current;
  const currentPosition = current?.position;
  const wasReplaying = replayingArchived;
  apply();
  const changedCurrent = current?.position !== currentPosition || replayingArchived !== wasReplaying;
  const updatedCutoff = show?.archiveThrough;
  const updatedEntries = Object.entries(state.listening).filter(([key, entry]) => before[key] !== entry);
  const removedNewIds = newIds.filter(id => !show?.newIds?.includes(id));
  const remainingKeys = new Set(state.queue.map(episodeKey));
  const removedQueue = queue.filter(entry => !remainingKeys.has(episodeKey(entry)));

  offerUndo(message, () => {
    for (const [key, updated] of updatedEntries) {
      if (state.listening[key] !== updated) continue;
      if (before[key]) state.listening[key] = before[key];
      else delete state.listening[key];
    }
    if (changedCurrent && state.current === current && current?.position === 0) {
      current.position = currentPosition;
      replayingArchived = wasReplaying;
    }
    if (show && state.shows.includes(show)) {
      if (show.archiveThrough === updatedCutoff) show.archiveThrough = cutoff;
      const recent = new Set(show.episodes.map(entry => entry.id));
      const restoredIds = removedNewIds.filter(id => recent.has(id) &&
        episodeKey({ feed: show.feed, id }) !== (state.current && !audio.paused ? episodeKey(state.current) : ''));
      show.newIds = [...new Set([...(show.newIds || []), ...restoredIds])];
      for (const entry of removedQueue) {
        const key = episodeKey(entry);
        if (state.queue.some(item => episodeKey(item) === key) ||
            (state.current && episodeKey(state.current) === key && !audio.paused)) continue;
        const next = queue.slice(queue.indexOf(entry) + 1);
        const index = state.queue.findIndex(item => next.some(candidate => episodeKey(candidate) === episodeKey(item)));
        state.queue.splice(index < 0 ? state.queue.length : index, 0, entry);
      }
    }
    if (reopenPlayer && !state.current && current) {
      openEpisode(current, false);
      setPlayerExpanded(true);
    }
    save();
    render();
  });
}

function archiveThrough(episode) {
  const show = state.shows.find(show => show.feed === episode.feed);
  if (!show || !episode.date || !confirm(beanLocale.text('Archiviare questa puntata di ') + episode.show +
      beanLocale.text(' e tutte quelle pubblicate fino alla stessa data e ora, comprese quelle che bean! caricherà in futuro?'))) return;

  if (state.current?.feed === show.feed && isBeforeArchiveCutoff(state.current, episode.date)) rememberPosition();
  archiveWithUndo(episode, beanLocale.text('Puntate archiviate'), () => {
    show.archiveThrough = Math.max(show.archiveThrough || 0, episode.date);
    for (const entry of Object.values(state.listening)) {
      if (entry.feed === show.feed && isBeforeArchiveCutoff(entry, episode.date) &&
          (!entry.listened || entry.position > 0)) {
        setListened(entry, true);
      }
    }
    if (state.current?.feed === show.feed && isBeforeArchiveCutoff(state.current, episode.date)) {
      setListened(state.current, true);
    }
    state.queue = state.queue.filter(entry => entry.feed !== show.feed || !isListened(entry, show));
    const catalog = episodeCatalogs.get(show.feed)?.episodes ?? show.episodes;
    const archivedIds = new Set(catalog.filter(entry => isListened({ ...entry, feed: show.feed }, show)).map(entry => entry.id));
    show.newIds = (show.newIds || []).filter(id => !archivedIds.has(id));
  });
  save();
  render();
}

function clearNewEpisode(episode) {
  const show = state.shows.find(show => show.feed === episode.feed);
  if (!show?.newIds?.includes(episode.id)) return false;
  show.newIds = show.newIds.filter(id => id !== episode.id);
  return true;
}

function updateFeed(show, feed) {
  episodeCatalogs.set(show.feed, feed);
  const recent = feed.episodes.slice(0, pageSize);
  const previousIds = new Set(show.episodes.map(episode => episode.id));
  const latestDate = Math.max(0, ...show.episodes.map(episode => episode.date));
  const newIds = new Set(show.newIds || []);
  for (const episode of recent) {
    if (!previousIds.has(episode.id) && episode.date >= latestDate &&
        !state.listening[episodeKey({ ...episode, feed: show.feed })] &&
        !isListened({ ...episode, feed: show.feed }, show)) {
      newIds.add(episode.id);
    }
  }
  show.episodes = recent;
  show.newIds = recent.filter(episode => newIds.has(episode.id) &&
    !isListened({ ...episode, feed: show.feed }, show)).map(episode => episode.id);
  show.artwork ||= feed.artwork;
}

function setListened(episode, listened) {
  const key = episodeKey(episode);
  const { position = 0 } = state.listening[key] || {};
  state.listening[key] = { ...episode, listened, restored: !listened, position: listened ? 0 : position };
  if (state.current && episodeKey(state.current) === key && listened) {
    state.current.position = 0;
    replayingArchived = false;
  }
  if (listened) {
    clearNewEpisode(episode);
    state.queue = state.queue.filter(entry => episodeKey(entry) !== key);
  }
}

function markListened(episode, listened, manual = true) {
  if (listened && manual) {
    if (state.current && episodeKey(state.current) === episodeKey(episode)) rememberPosition();
    archiveWithUndo(episode, beanLocale.text('Puntata archiviata'), () => setListened(episode, true));
  } else {
    setListened(episode, listened);
  }
  save();
  render();
}

function addToQueue(episode) {
  if (!state.queue.some(entry => episodeKey(entry) === episodeKey(episode))) {
    state.queue.push(episode);
    save();
    render();
  }
}

function noteLink(href) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function appendNoteText(target, text) {
  let offset = 0;
  for (const match of text.matchAll(/https?:[^\s<>"']+/gi)) {
    const address = match[0].replace(/[.,;!?]+$/, '');
    const href = webLink(address);
    if (!href) continue;
    target.append(text.slice(offset, match.index));
    const link = noteLink(href);
    link.textContent = address;
    target.append(link);
    offset = match.index + address.length;
  }
  target.append(text.slice(offset));
}

function appendNotes(target, nodes, baseUrl, insideLink = false) {
  const blocks = ['p', 'div', 'li', 'ul', 'ol', 'blockquote', 'h2', 'h3', 'h4'];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (insideLink) target.append(node.textContent);
      else appendNoteText(target, node.textContent);
      continue;
    }
    const tag = node.localName;
    if (!tag || ['script', 'style', 'template', 'iframe', 'noscript'].includes(tag)) continue;
    const href = tag === 'a' ? webLink(node.getAttribute('href'), baseUrl) : '';
    const safeTag = href ? 'a' : blocks.includes(tag) ? tag : tag === 'br' ? 'br' : '';
    const element = href ? noteLink(href) : safeTag ? document.createElement(safeTag) : target;
    appendNotes(element, node.childNodes, baseUrl, insideLink || Boolean(href));
    if (safeTag) target.append(element);
  }
}

function showEpisodeInfo(episode) {
  const notes = $('episode-notes');
  notes.replaceChildren();
  const baseUrl = webLink(episode.link, episode.feed) || episode.feed;
  const template = document.createElement('template');
  template.innerHTML = typeof episode.notes === 'string' ? episode.notes : '';
  appendNotes(notes, template.content.childNodes, baseUrl);
  if (!notes.textContent.trim()) notes.textContent = beanLocale.text('Nessuna descrizione disponibile per questa puntata.');

  const page = $('episode-page');
  const href = webLink(episode.link, episode.feed);
  page.hidden = !href;
  if (href) page.firstElementChild.href = href;
  else page.firstElementChild.removeAttribute('href');
  $('episode-info-title').textContent = episode.title;
  $('episode-info').showModal();
}

function episodeRow(episode, show, menuOpen) {
  const listened = isListened(episode, show);
  const entry = state.listening[episodeKey(episode)];
  const date = episode.date ? new Date(episode.date).toLocaleDateString(beanLocale.locale) : '';
  const progress = entry?.position >= 1 ? 'A ' + clock(entry.position) : '';
  const isNew = state.shows.find(show => show.feed === episode.feed)?.newIds?.includes(episode.id);
  const item = row(episode.title, [isNew ? beanLocale.text('Nuova') : '', date, progress].filter(Boolean).join(' · '));
  item.className = 'episode';
  const labels = item.firstElementChild;
  const actions = document.createElement('div');
  actions.className = 'episode-actions';
  const playLabel = entry?.position > 0 ? beanLocale.text('Riprendi') : listened ? beanLocale.text('Riascolta') : beanLocale.text('Ascolta');
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'episode-play';
  play.setAttribute('aria-label', playLabel + ' ' + episode.title);
  play.onclick = () => selectEpisode(episode);
  const icon = document.createElement('span');
  icon.className = 'episode-play-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '▶';
  const text = document.createElement('span');
  text.append(...labels.childNodes);
  play.append(text, icon);
  labels.replaceWith(play);
  const markLabel = listened ? beanLocale.text('Da ascoltare') : beanLocale.text('Già ascoltato');
  const more = details('⋯', menuOpen);
  more.dataset.episodeId = episode.id;
  more.firstChild.setAttribute('aria-label', beanLocale.text('Altre azioni · ') + episode.title);
  button(more, beanLocale.text('Info puntata'), () => showEpisodeInfo(episode), beanLocale.text('Info puntata · ') + episode.title);
  button(more, markLabel, () => markListened(episode, !listened),
    markLabel + ' · ' + episode.title);
  more.className = 'episode-more';
  if (!listened) {
    const queued = state.queue.some(candidate => episodeKey(candidate) === episodeKey(episode));
    button(more, queued ? beanLocale.text('Togli dalla coda') : beanLocale.text('In coda'), () => {
      if (!queued) {
        addToQueue(episode);
        return;
      }
      state.queue = state.queue.filter(candidate => episodeKey(candidate) !== episodeKey(episode));
      save();
      render();
    });
  }
  if (episode.date) {
    const secondary = document.createElement('div');
    secondary.className = 'archive-action';
    button(secondary, beanLocale.text('Archivia fino a qui'), () => archiveThrough(episode));
    more.append(secondary);
  }
  actions.append(more);
  item.append(actions);
  return item;
}

function details(label, open) {
  const panel = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  panel.open = open;
  panel.append(summary);
  return panel;
}

function renderShortcuts() {
  const followed = new Set(state.shows.map(show => show.feed));
  const currentKey = state.current ? episodeKey(state.current) : null;
  const inProgress = Object.values(state.listening)
    .filter(entry => entry.position > 0 &&
      followed.has(entry.feed) && episodeKey(entry) !== currentKey)
    .sort((a, b) => (b.touched || 0) - (a.touched || 0));
  $('listening-home').hidden = (!inProgress.length && !state.queue.length) || !player.hidden;
  $('resume-list').replaceChildren();
  if (!inProgress.length) empty($('resume-list'), beanLocale.text('Nessuna puntata da riprendere.'));
  for (const episode of inProgress) {
    const item = row(episode.title, episode.show + ' · ' + clock(episode.position));
    button(item, '▶', () => selectEpisode(episode), beanLocale.text('Riprendi ') + episode.title);
    button(item, '✓', () => markListened(episode, true), beanLocale.text('Segna come ascoltato · ') + episode.title);
    $('resume-list').append(item);
  }
  $('queue-list').replaceChildren();
  if (!state.queue.length) empty($('queue-list'), beanLocale.text('La coda è vuota.'));
  state.queue.forEach((episode, index) => {
    const item = row(episode.title, episode.show);
    button(item, 'Play', () => selectEpisode(episode), beanLocale.text('Ascolta ') + episode.title);
    if (index > 0) button(item, '↑', () => {
      state.queue.unshift(...state.queue.splice(index, 1));
      save();
      render();
    }, beanLocale.text('Metti per prima ') + episode.title);
    button(item, '×', () => {
      state.queue.splice(index, 1);
      save();
      render();
    }, beanLocale.text('Togli dalla coda ') + episode.title);
    $('queue-list').append(item);
  });
}

const podcastCollator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const podcastOrder = $('podcast-order');
podcastOrder.value = state.podcastOrder === 'recent' ? 'recent' : 'title';
podcastOrder.onchange = () => {
  state.podcastOrder = podcastOrder.value;
  save();
  render();
};

function orderedPodcasts() {
  const compareTitle = (a, b) => podcastCollator.compare(a.title, b.title);
  if (podcastOrder.value !== 'recent') return [...state.shows].sort(compareTitle);

  const days = new Map(state.shows.map(show => {
    const latest = show.episodes.reduce((max, episode) =>
      Number.isFinite(episode.date) && episode.date !== 0 ? Math.max(max, episode.date) : max, -Infinity);
    const day = Number.isFinite(latest) ? new Date(latest).setHours(0, 0, 0, 0) : -Infinity;
    return [show, day];
  }));
  return [...state.shows].sort((a, b) => days.get(b) - days.get(a) || compareTitle(a, b));
}

async function showOlderEpisodes(show, limits, limit, hasMoreLocally, control) {
  const catalog = episodeCatalogs.get(show.feed);
  if (!hasMoreLocally && catalog?.nextPage) {
    if (loadingOlder.has(show.feed)) return;
    loadingOlder.add(show.feed);
    control.disabled = true;
    const label = control.textContent;
    control.textContent = beanLocale.text('Carico le puntate…');
    try {
      const page = await readSpreakerEpisodes(new URL(catalog.nextPage));
      if (episodeCatalogs.get(show.feed) !== catalog) return;
      const known = new Set(catalog.episodes.map(episode => episode.id));
      for (const episode of page.episodes) {
        if (known.has(episode.id)) continue;
        catalog.episodes.push(episode);
        known.add(episode.id);
      }
      catalog.nextPage = page.nextPage;
    } catch {
      status(beanLocale.text('Non riesco a caricare le puntate precedenti. Riprova.'));
      return;
    } finally {
      loadingOlder.delete(show.feed);
      control.disabled = false;
      control.textContent = label;
    }
  }
  limits.set(show.feed, limit + pageSize);
  render();
}

function podcastPanelState(panel, preserveMenus) {
  return {
    open: panel.open,
    archive: panel.querySelector('.archive')?.open,
    menu: preserveMenus && Boolean(panel.querySelector('.podcast-more[open]')),
    episodeMenus: new Set(preserveMenus
      ? [...panel.querySelectorAll('.episode-more[open]')].map(menu => menu.dataset.episodeId)
      : [])
  };
}

function render(preserveMenus = false) {
  renderShortcuts();
  const following = $('following');
  const oldPanels = new Map([...following.querySelectorAll('details[data-feed]')]
    .map(panel => [panel.dataset.feed, podcastPanelState(panel, preserveMenus)]));
  following.replaceChildren();

  if (!state.shows.length) {
    empty(following, beanLocale.text('Cerca un podcast e premi Segui.'));
    return;
  }

  for (const show of orderedPodcasts()) {
    const item = document.createElement('li');
    item.className = 'podcast';
    const savedPanel = oldPanels.get(show.feed);
    const podcast = details(show.title, savedPanel?.open ?? state.shows.length === 1);
    podcast.dataset.feed = show.feed;
    podcast.setAttribute('name', 'bean-podcasts');
    const thumbnail = document.createElement('span');
    thumbnail.className = 'podcast-cover';
    thumbnail.append(cover(show.artwork));
    if (show.newIds?.length) {
      const dot = document.createElement('span');
      dot.className = 'new-dot';
      const label = document.createElement('span');
      label.className = 'sr';
      label.textContent = beanLocale.text('Nuove puntate');
      thumbnail.append(dot, label);
    }
    podcast.firstChild.prepend(thumbnail);
    podcast.firstChild.addEventListener('click', () => {
      if (!podcast.open) setPlayerExpanded(false);
    });
    const episodePanel = document.createElement('div');
    episodePanel.className = 'podcast-episodes';
    const header = document.createElement('div');
    header.className = 'podcast-header';
    const author = document.createElement('small');
    author.textContent = show.author;
    header.append(author);
    const menu = details('⋯', savedPanel?.menu ?? false);
    menu.className = 'podcast-more';
    menu.firstChild.setAttribute('aria-label', beanLocale.text('Opzioni · ') + show.title);
    button(menu, beanLocale.text('Smetti di seguire'), () => {
      if (!confirm(beanLocale.text('Smettere di seguire «') + show.title + '»?')) return;
      state.shows = state.shows.filter(candidate => candidate !== show);
      episodeCatalogs.delete(show.feed);
      visibleEpisodes.delete(show.feed);
      visibleArchived.delete(show.feed);
      state.queue = state.queue.filter(episode => episode.feed !== show.feed);
      save();
      render();
    }, beanLocale.text('Smetti di seguire ') + show.title);
    header.append(menu);
    episodePanel.append(header);

    const episodes = new Map();
    for (const entry of Object.values(state.listening)) {
      if (entry.feed === show.feed) {
        episodes.set(entry.id, entry);
      }
    }
    const catalog = episodeCatalogs.get(show.feed);
    for (const episode of catalog?.episodes ?? show.episodes) {
      episodes.set(episode.id, { ...episode, show: show.title, feed: show.feed });
    }
    const pending = document.createElement('ul');
    const listened = document.createElement('ul');
    const ordered = [...episodes.values()].sort((a, b) => b.date - a.date);
    const remaining = [];
    const archived = [];
    for (const episode of ordered) {
      (isListened(episode, show) ? archived : remaining).push(episode);
    }
    const limit = visibleEpisodes.get(show.feed) ?? pageSize;
    const archiveLimit = visibleArchived.get(show.feed) ?? pageSize;
    const olderInArchive = Boolean(catalog?.nextPage && show.archiveThrough &&
      catalog.episodes.some(episode => isBeforeArchiveCutoff(episode, show.archiveThrough)));
    const olderInPending = Boolean(catalog?.nextPage && !olderInArchive);
    for (const episode of remaining.slice(0, limit)) {
      pending.append(episodeRow(episode, show, savedPanel?.episodeMenus.has(episode.id) ?? false));
    }
    for (const episode of archived.slice(0, archiveLimit)) {
      listened.append(episodeRow(episode, show, savedPanel?.episodeMenus.has(episode.id) ?? false));
    }
    if (!pending.children.length) empty(pending, beanLocale.text('Nessuna puntata da ascoltare.'));
    episodePanel.append(pending);
    if (remaining.length > limit || olderInPending) {
      button(episodePanel, beanLocale.text('Mostra puntate precedenti'),
        control => showOlderEpisodes(show, visibleEpisodes, limit, remaining.length > limit, control),
        beanLocale.text('Mostra puntate precedenti · ') + show.title);
      episodePanel.lastElementChild.className = 'older-episodes';
    }
    if (archived.length || olderInArchive) {
      const archive = details(beanLocale.text('Puntate archiviate (') + archived.length + ')', savedPanel?.archive ?? false);
      archive.className = 'archive';
      archive.append(listened);
      if (archived.length > archiveLimit || olderInArchive) {
        button(archive, beanLocale.text('Mostra altre puntate archiviate'),
          control => showOlderEpisodes(show, visibleArchived, archiveLimit, archived.length > archiveLimit, control),
          beanLocale.text('Mostra altre puntate archiviate · ') + show.title);
        archive.lastElementChild.className = 'older-episodes';
      }
      episodePanel.append(archive);
    }
    podcast.append(episodePanel);
    item.append(podcast);
    following.append(item);
  }
}

async function updateShows(manual = false, startup = false) {
  if (refreshing) return;
  const shows = state.shows.filter(show => manual || startup || Date.now() - (show.checked || 0) >= interval);
  if (!shows.length) {
    if (manual) status(beanLocale.text('Segui un podcast per aggiornare le puntate.'));
    return;
  }
  refreshing = true;
  $('refresh').disabled = true;
  if (manual) status(beanLocale.text('Aggiorno le puntate…'));
  let failures = 0;
  try {
    for (const show of shows) {
      try {
        const feed = await readEpisodes(show.feed);
        updateFeed(show, feed);
        if (state.current?.feed === show.feed) updatePlayerCover();
      } catch {
        failures++;
      }
      show.checked = Date.now();
      save();
      render(true);
    }
    if (manual || failures) {
      status(failures ? beanLocale.text("Feed non raggiungibili: {0} su {1}.", failures, shows.length) : beanLocale.text('Puntate aggiornate.'));
    }
  } finally {
    refreshing = false;
    $('refresh').disabled = false;
  }
}

$('query').addEventListener('focus', () => setPlayerExpanded(false));
$('search').addEventListener('submit', async event => {
  event.preventDefault();
  setPlayerExpanded(false);
  const q = $('query').value.trim();
  if (!q) return;
  const submit = $('search').querySelector('button');
  submit.disabled = true;
  status(beanLocale.text('Cerco nel catalogo…'));
  $('results-section').hidden = true;
  const results = $('results');
  results.replaceChildren();
  try {
    const matches = await searchPodcasts(q);
    if (!matches.length) empty(results, beanLocale.text('Nessun podcast trovato.'));
    for (const match of matches) {
      const item = row(match.title, match.author);
      item.prepend(cover(match.artwork));
      const followed = state.shows.some(show => show.feed === match.feed);
      button(item, followed ? beanLocale.text('Seguito') : beanLocale.text('Segui'), async control => {
        if (state.shows.some(show => show.feed === match.feed)) return;
        control.disabled = true;
        status(beanLocale.text('Carico le puntate…'));
        try {
          const feed = await readEpisodes(match.feed);
          episodeCatalogs.set(match.feed, feed);
          state.shows.push({ ...match, episodes: feed.episodes.slice(0, pageSize),
            artwork: match.artwork || feed.artwork, checked: Date.now() });
          save();
          render();
          control.textContent = beanLocale.text('Seguito');
          status();
        } catch {
          control.disabled = false;
          status(beanLocale.text('Non riesco a leggere il feed di questo podcast.'));
        }
      });
      item.querySelector('button').disabled = followed;
      results.append(item);
    }
    $('results-section').hidden = false;
    status();
  } catch {
    status(beanLocale.text('Ricerca non disponibile. Riprova tra poco.'));
  } finally {
    submit.disabled = false;
  }
});

$('close-results').onclick = () => { $('results-section').hidden = true; };
$('refresh').onclick = () => updateShows(true);

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const tail = String(total % 60).padStart(2, '0');
  return minutes < 60 ? `${minutes}:${tail}` :
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${tail}`;
}

function rememberPosition() {
  if (!state.current) return;
  const position = audio.currentTime;
  if (!Number.isFinite(position) || (position === 0 && (audio.readyState === 0 || resumeAt > 0))) return;
  lastSavedPosition = position;
  const key = episodeKey(state.current);
  const listened = isListened(state.current);
  if (listened && !replayingArchived) return;
  state.current.position = lastSavedPosition;
  state.listening[key] = { ...state.current, listened, restored: state.listening[key]?.restored, touched: Date.now() };
  save();
}

function showAudioError(message = '') {
  $('audio-error').textContent = message;
  $('audio-error').hidden = !message;
}

function play() {
  if (state.current) replayingArchived = isListened(state.current);
  showAudioError();
  audio.play().catch(error => {
    if (error.name !== 'AbortError') showAudioError(beanLocale.text('Riproduzione non disponibile. Tocca Play per riprovare.'));
  });
}

function selectEpisode(episode) {
  if (listeningDialog.open) listeningDialog.close();
  openEpisode(episode);
  setPlayerExpanded(true);
}

function openEpisode(episode, autoplay = true) {
  const same = state.current?.feed === episode.feed && state.current?.id === episode.id;
  if (same && audio.hasAttribute('src')) {
    if (autoplay) {
      if (audio.ended) seek(0);
      play();
    }
    return;
  }

  rememberPosition();
  const saved = state.listening[episodeKey(episode)];
  replayingArchived = false;
  resumeAt = saved?.position ?? (same ? state.current.position || 0 : 0);
  lastSavedPosition = resumeAt;
  state.current = { ...episode, position: resumeAt };
  save();
  $('player').hidden = false;
  renderShortcuts();
  $('playing-title').textContent = episode.title;
  $('playing-show').textContent = episode.show;
  showAudioError();
  audio.src = episode.url;
  audio.playbackRate = Number($('rate').value);
  updateTimeline();
  updatePlayerCover();
  if (autoplay) play();
}

function updatePlayerCover() {
  const episode = state.current;
  if (!episode) return;
  const artwork = state.shows.find(show => show.feed === episode.feed)?.artwork;
  setCover($('playing-cover'), artwork);
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: episode.title,
      artist: episode.show,
      artwork: artwork ? [{ src: artwork }] :
        [{ src: new URL('icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
    });
  }
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

function setPlayerExpanded(expanded) {
  $('player').classList.toggle('is-expanded', expanded);
  $('player-view').setAttribute('aria-expanded', String(expanded));
  $('player-view').disabled = expanded;
}

$('player-view').onclick = () => {
  setPlayerExpanded(true);
  $('toggle').focus();
};
$('listening-home').onclick = $('listening-player').onclick = () => listeningDialog.showModal();
$('info-player').onclick = () => {
  const episode = state.current;
  if (!episode) return;
  const catalog = episodeCatalogs.get(episode.feed)?.episodes ??
    state.shows.find(show => show.feed === episode.feed)?.episodes;
  const latest = catalog?.find(item => item.id === episode.id);
  showEpisodeInfo(latest ? { ...episode, ...latest } : episode);
};

function finishCurrentEpisode() {
  if (!state.current) return;
  rememberPosition();
  archiveWithUndo(state.current, beanLocale.text('Puntata archiviata'), () => setListened(state.current, true), true);
  if (state.queue.length) {
    openEpisode(state.queue[0]);
  } else {
    audio.pause();
    state.current = null;
    audio.removeAttribute('src');
    audio.load();
    $('player').hidden = true;
    setPlayerExpanded(false);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
    save();
  }
  render();
}

$('finish-episode').onclick = finishCurrentEpisode;

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
    $('toggle').setAttribute('aria-label', audio.paused ? beanLocale.text('Riproduci') : beanLocale.text('Pausa'));
    $('toggle').classList.toggle('is-playing', !audio.paused);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state.current ? (audio.paused ? 'paused' : 'playing') : 'none';
    if (event === 'play' && state.current) {
      const key = episodeKey(state.current);
      const queued = state.queue.findIndex(entry => episodeKey(entry) === key);
      if (queued >= 0) {
        state.queue.splice(queued, 1);
        save();
        render(true);
      }
    }
    if (event === 'ended' && state.current) {
      markListened(state.current, true, false);
      if (state.queue.length) openEpisode(state.queue[0]);
    }
    if (event === 'pause') {
      rememberPosition();
      render(true);
    }
  });
}
audio.addEventListener('playing', () => {
  if (state.current && clearNewEpisode(state.current)) {
    save();
    render(true);
  }
});
audio.addEventListener('error', () => showAudioError(beanLocale.text('Audio non disponibile per questa puntata.')));

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

const libraryDialog = $('library-dialog');
const libraryStatus = $('library-status');

$('library-open').onclick = () => {
  libraryStatus.textContent = '';
  $('opml-import').disabled = $('opml-export').disabled = $('backup-export').disabled = !storageReadable;
  libraryDialog.showModal();
};

function saveFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function feedAddress(address) {
  const valid = webLink(address);
  if (!valid) return '';
  const url = new URL(valid);
  url.hash = '';
  return url.href;
}

function opmlText(shows) {
  const xml = document.implementation.createDocument(null, 'opml');
  const root = xml.documentElement;
  root.setAttribute('version', '2.0');
  const head = xml.createElement('head');
  const title = xml.createElement('title');
  title.textContent = 'bean!';
  head.append(title);
  const body = xml.createElement('body');
  for (const show of shows) {
    const outline = xml.createElement('outline');
    outline.setAttribute('type', 'rss');
    outline.setAttribute('text', show.title);
    outline.setAttribute('title', show.title);
    outline.setAttribute('xmlUrl', show.feed);
    body.append(outline);
  }
  root.append(head, body);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(xml);
}

function opmlShows(text) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const body = [...xml.documentElement.children].find(element => element.localName === 'body');
  if (xml.documentElement.localName !== 'opml' || xml.querySelector('parsererror') || !body) {
    throw new Error(beanLocale.text('Il file OPML non è valido.'));
  }
  const shows = [];
  const known = new Set(state.shows.map(show => feedAddress(show.feed)));
  let feeds = 0;
  for (const outline of body.getElementsByTagNameNS('*', 'outline')) {
    const feed = feedAddress(outline.getAttribute('xmlUrl') || outline.getAttribute('xmlurl'));
    if (!feed) continue;
    feeds++;
    if (known.has(feed)) continue;
    known.add(feed);
    const title = outline.getAttribute('title')?.trim() || outline.getAttribute('text')?.trim() || new URL(feed).hostname;
    shows.push({ title, feed, author: '', episodes: [], newIds: [], checked: 0 });
  }
  if (!feeds) throw new Error(beanLocale.text('Il file OPML non contiene feed utilizzabili.'));
  return shows;
}

function backupState(text) {
  const parsed = JSON.parse(text);
  const saved = parsed?.format === 'bean-backup' && parsed.version === 1 ? parsed.library : parsed;
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const episode = value => record(value) && typeof value.id === 'string' &&
    typeof value.title === 'string' && Boolean(webLink(value.url));
  const entry = value => episode(value) && Boolean(feedAddress(value.feed)) && typeof value.show === 'string';
  const show = value => record(value) && typeof value.title === 'string' && Boolean(feedAddress(value.feed)) &&
    Array.isArray(value.episodes) && value.episodes.every(episode) &&
    (value.newIds == null || (Array.isArray(value.newIds) && value.newIds.every(id => typeof id === 'string')));
  if (!record(saved) || !Array.isArray(saved.shows) || !saved.shows.every(show) ||
      (saved.listening != null && (!record(saved.listening) || !Object.values(saved.listening).every(entry))) ||
      (saved.queue != null && (!Array.isArray(saved.queue) || !saved.queue.every(entry))) ||
      (saved.current != null && !entry(saved.current))) {
    throw new Error(beanLocale.text('Il file non è un backup di bean! compatibile.'));
  }
  return saved;
}

function bindImport(button, field, apply) {
  const input = $(field);
  $(button).onclick = () => input.click();
  input.onchange = async () => {
    const [file] = input.files;
    input.value = '';
    if (!file) return;
    try {
      await apply(await file.text());
    } catch (error) {
      libraryStatus.textContent = error instanceof SyntaxError
        ? beanLocale.text('Il file non è un backup di bean! compatibile.')
        : error.message || beanLocale.text('Impossibile importare il file.');
    }
  };
}

$('opml-export').onclick = () => {
  saveFile('bean-abbonamenti.opml', opmlText(state.shows), 'text/x-opml;charset=utf-8');
};
$('backup-export').onclick = () => {
  rememberPosition();
  const backup = { format: 'bean-backup', version: 1, library: state };
  saveFile('bean-backup.json', JSON.stringify(backup, null, 2), 'application/json;charset=utf-8');
};
bindImport('opml-import', 'opml-file', text => {
  if (!storageReadable || restoring) return;
  const shows = opmlShows(text);
  if (!shows.length) {
    libraryStatus.textContent = beanLocale.text('Questi podcast sono già nella lista.');
    return;
  }
  const merged = { ...state, shows: [...state.shows, ...shows] };
  storeLibrary(merged);
  state = merged;
  render();
  libraryStatus.textContent = beanLocale.text('Abbonamenti aggiunti: {0}.', shows.length);
  void updateShows();
});
bindImport('backup-import', 'backup-file', text => {
  if (restoring) return;
  const saved = backupState(text);
  if (!confirm(beanLocale.text('Sostituire l’archivio corrente con questo backup ({0} podcast)?', saved.shows.length))) return;
  storeLibrary(saved);
  restoring = true;
  location.reload();
});

function start() {
  if (!storageReadable) throw new Error('Unreadable podcast library');
  render();
  if (state.current) openEpisode(state.current, false);
  updateShows(false, true);
  setInterval(() => { if (!document.hidden) updateShows(); }, interval);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rememberPosition();
    else updateShows();
  });
}

try {
  start();
} catch (error) {
  console.error(error);
  $('query').disabled = true;
  $('search').querySelector('button').disabled = true;
  $('refresh').disabled = true;
  status(beanLocale.text('Avvio interrotto. Apri «Controlla archivio» per verificare i dati salvati.'));
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
