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
      status.textContent = 'In Chrome apri il menu ⋮ e scegli «Aggiungi a schermata Home» o «Installa app», se disponibile.';
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
      status.textContent = 'Il browser non ha aperto la richiesta. Riprova dal menu ⋮.';
    } finally {
      button.disabled = false;
    }
  });
})();

'use strict';

const $ = id => document.getElementById(id);
const audio = $('audio');
const pageSize = 30;
const episodeCatalogs = new Map();
const visibleEpisodes = new Map();
const loadingOlder = new Set();
const interval = 30 * 60 * 1000;
const storageKey = 'bean-library-v1';
let state = { shows: [], current: null, rate: 1 };
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Array.isArray(saved.shows)) state = saved;
} catch {
  // An unreadable library starts empty.
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
          artwork: artworkUrl(item.artworkUrl600 || item.artworkUrl100),
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
  if (!Array.isArray(show?.items)) throw new Error('Risposta Spreaker non valida');
  const episodes = show.items.flatMap(item => {
    const id = String(item.episode_id || '');
    const playback = item.playback_url;
    if (!/^\d+$/.test(id) || typeof playback !== 'string') return [];
    const audio = new URL(playback);
    if (audio.protocol !== 'https:' || audio.username || audio.password) return [];
    // Match the GUID in Spreaker's RSS so archives, progress and novelty survive.
    return [{
      id: 'https://api.spreaker.com/episode/' + id,
      title: String(item.title || 'Puntata').slice(0, 300),
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
    throw new Error('Indirizzo del feed non valido');
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
    throw new Error('Feed non valido');
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
          title: (textOf(item, 'title') || 'Puntata').slice(0, 300),
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
        !state.listening[episodeKey({ ...episode, feed: show.feed })]) {
      newIds.add(episode.id);
    }
  }
  show.episodes = recent;
  show.newIds = recent.filter(episode => newIds.has(episode.id)).map(episode => episode.id);
  show.artwork ||= feed.artwork;
}

function setListened(episode, listened) {
  const key = episodeKey(episode);
  const { position = 0 } = state.listening[key] || {};
  state.listening[key] = { ...episode, listened, position: listened ? 0 : position };
  if (state.current && episodeKey(state.current) === key && listened) {
    state.current.position = 0;
    replayingArchived = false;
  }
  if (listened) {
    clearNewEpisode(episode);
    state.queue = state.queue.filter(entry => episodeKey(entry) !== key);
  }
}

function markListened(episode, listened) {
  setListened(episode, listened);
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
  if (!notes.textContent.trim()) notes.textContent = 'Nessuna descrizione disponibile per questa puntata.';

  const page = $('episode-page');
  const href = webLink(episode.link, episode.feed);
  page.hidden = !href;
  if (href) page.firstElementChild.href = href;
  else page.firstElementChild.removeAttribute('href');
  $('episode-info-title').textContent = episode.title;
  $('episode-info').showModal();
}

function episodeRow(episode, older = []) {
  const entry = state.listening[episodeKey(episode)];
  const date = episode.date ? new Date(episode.date).toLocaleDateString('it-IT') : '';
  const progress = entry?.position >= 1 ? 'A ' + clock(entry.position) : '';
  const isNew = state.shows.find(show => show.feed === episode.feed)?.newIds?.includes(episode.id);
  const item = row(episode.title, [isNew ? 'Nuova' : '', date, progress].filter(Boolean).join(' · '));
  item.className = 'episode';
  const actions = document.createElement('div');
  actions.className = 'episode-actions';
  const playLabel = entry?.position > 0 ? 'Riprendi' : entry?.listened ? 'Riascolta' : 'Ascolta';
  button(actions, '▶', () => selectEpisode(episode), playLabel + ' ' + episode.title);
  const markLabel = entry?.listened ? 'Da ascoltare' : 'Già ascoltato';
  const more = details('⋯', false);
  more.firstChild.setAttribute('aria-label', 'Altre azioni · ' + episode.title);
  button(more, 'Info puntata', () => showEpisodeInfo(episode), 'Info puntata · ' + episode.title);
  button(more, markLabel, () => markListened(episode, !entry?.listened),
    markLabel + ' · ' + episode.title);
  more.className = 'episode-more';
  if (!entry?.listened) {
    const queued = state.queue.some(candidate => episodeKey(candidate) === episodeKey(episode));
    button(more, queued ? 'Togli dalla coda' : 'In coda', () => {
      if (!queued) {
        addToQueue(episode);
        return;
      }
      state.queue = state.queue.filter(candidate => episodeKey(candidate) !== episodeKey(episode));
      save();
      render();
    });
    if (older.length) {
      const secondary = document.createElement('div');
      secondary.className = 'archive-action';
      button(secondary, 'Archivia fino a qui', () => {
        const batch = [episode, ...older];
        if (!confirm('Archiviare ' + batch.length + ' puntate di ' + episode.show + '?')) return;
        batch.forEach(candidate => setListened(candidate, true));
        save();
        render();
      });
      more.append(secondary);
    }
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
  $('resume-home').hidden = !inProgress.length || !$('player').hidden;
  $('resume-list').replaceChildren();
  if (!inProgress.length) empty($('resume-list'), 'Nessuna puntata da riprendere.');
  for (const episode of inProgress) {
    const item = row(episode.title, episode.show + ' · ' + clock(episode.position));
    button(item, '▶', () => selectEpisode(episode), 'Riprendi ' + episode.title);
    button(item, '✓', () => markListened(episode, true), 'Segna come ascoltato · ' + episode.title);
    $('resume-list').append(item);
  }
  $('queue-home').hidden = !state.queue.length || !$('player').hidden;
  $('queue-list').replaceChildren();
  if (!state.queue.length) empty($('queue-list'), 'La coda è vuota.');
  state.queue.forEach((episode, index) => {
    const item = row(episode.title, episode.show);
    button(item, 'Play', () => selectEpisode(episode), 'Ascolta ' + episode.title);
    if (index > 0) button(item, '↑', () => {
      state.queue.unshift(...state.queue.splice(index, 1));
      save();
      render();
    }, 'Metti per prima ' + episode.title);
    button(item, '×', () => {
      state.queue.splice(index, 1);
      save();
      render();
    }, 'Togli dalla coda ' + episode.title);
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

async function showOlderEpisodes(show, limit, hasMoreLocally, control) {
  const catalog = episodeCatalogs.get(show.feed);
  if (!hasMoreLocally && catalog?.nextPage) {
    if (loadingOlder.has(show.feed)) return;
    loadingOlder.add(show.feed);
    control.disabled = true;
    control.textContent = 'Carico le puntate…';
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
      status('Non riesco a caricare le puntate precedenti. Riprova.');
      return;
    } finally {
      loadingOlder.delete(show.feed);
      control.disabled = false;
      control.textContent = 'Mostra puntate precedenti';
    }
  }
  visibleEpisodes.set(show.feed, limit + pageSize);
  render();
}

function render() {
  renderShortcuts();
  const following = $('following');
  const oldPanels = new Map([...following.querySelectorAll('details[data-feed]')]
    .map(panel => [panel.dataset.feed, { open: panel.open, archive: panel.querySelector('.archive')?.open }]));
  following.replaceChildren();

  if (!state.shows.length) {
    empty(following, 'Cerca un podcast e premi Segui.');
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
      label.textContent = 'Nuove puntate';
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
    button(header, 'Smetti di seguire', () => {
      state.shows = state.shows.filter(candidate => candidate !== show);
      episodeCatalogs.delete(show.feed);
      visibleEpisodes.delete(show.feed);
      state.queue = state.queue.filter(episode => episode.feed !== show.feed);
      save();
      render();
    }, 'Smetti di seguire ' + show.title);
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
    const remaining = ordered.filter(episode => !state.listening[episodeKey(episode)]?.listened);
    const archived = ordered.filter(episode => state.listening[episodeKey(episode)]?.listened);
    const limit = visibleEpisodes.get(show.feed) ?? pageSize;
    const visible = remaining.slice(0, limit);
    visible.forEach((episode, index) => {
      const older = episode.date ? visible.slice(index + 1)
        .filter(candidate => candidate.date > 0 && candidate.date <= episode.date) : [];
      pending.append(episodeRow(episode, older));
    });
    archived.forEach(episode => listened.append(episodeRow(episode)));
    if (!pending.children.length) empty(pending, 'Nessuna puntata da ascoltare.');
    episodePanel.append(pending);
    if (remaining.length > limit || catalog?.nextPage) {
      button(episodePanel, 'Mostra puntate precedenti',
        control => showOlderEpisodes(show, limit, remaining.length > limit, control),
        'Mostra puntate precedenti · ' + show.title);
      episodePanel.lastElementChild.className = 'older-episodes';
    }
    if (listened.children.length) {
      const archive = details('Puntate ascoltate (' + listened.children.length + ')', savedPanel?.archive ?? false);
      archive.className = 'archive';
      archive.append(listened);
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
        const feed = await readEpisodes(show.feed);
        updateFeed(show, feed);
        if (state.current?.feed === show.feed) updatePlayerCover();
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

$('query').addEventListener('focus', () => setPlayerExpanded(false));
$('search').addEventListener('submit', async event => {
  event.preventDefault();
  setPlayerExpanded(false);
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
      item.prepend(cover(match.artwork));
      const followed = state.shows.some(show => show.feed === match.feed);
      button(item, followed ? 'Seguito' : 'Segui', async control => {
        if (state.shows.some(show => show.feed === match.feed)) return;
        control.disabled = true;
        status('Carico le puntate…');
        try {
          const feed = await readEpisodes(match.feed);
          episodeCatalogs.set(match.feed, feed);
          state.shows.push({ ...match, episodes: feed.episodes.slice(0, pageSize),
            artwork: match.artwork || feed.artwork, checked: Date.now() });
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
  const listened = Boolean(state.listening[key]?.listened);
  if (listened && !replayingArchived) return;
  state.current.position = lastSavedPosition;
  state.listening[key] = { ...state.current, listened, touched: Date.now() };
  save();
}

function showAudioError(message = '') {
  $('audio-error').textContent = message;
  $('audio-error').hidden = !message;
}

function play() {
  if (state.current) replayingArchived = Boolean(state.listening[episodeKey(state.current)]?.listened);
  showAudioError();
  audio.play().catch(error => {
    if (error.name !== 'AbortError') showAudioError('Riproduzione non disponibile. Tocca Play per riprovare.');
  });
}

function selectEpisode(episode) {
  for (const id of ['queue-dialog', 'resume-dialog']) {
    if ($(id).open) $(id).close();
  }
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
$('resume-home').onclick = $('resume-player').onclick = () => $('resume-dialog').showModal();
$('queue-home').onclick = $('queue-player').onclick = () => $('queue-dialog').showModal();

function finishCurrentEpisode() {
  if (!state.current) return;
  setListened(state.current, true);
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
    $('toggle').setAttribute('aria-label', audio.paused ? 'Riproduci' : 'Pausa');
    $('toggle').classList.toggle('is-playing', !audio.paused);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state.current ? (audio.paused ? 'paused' : 'playing') : 'none';
    if (event === 'play' && state.current) {
      const key = episodeKey(state.current);
      const queued = state.queue.findIndex(entry => episodeKey(entry) === key);
      if (queued >= 0) {
        state.queue.splice(queued, 1);
        save();
        render();
      }
    }
    if (event === 'ended' && state.current) {
      markListened(state.current, true);
      if (state.queue.length) openEpisode(state.queue[0]);
    }
    if (event === 'pause') {
      rememberPosition();
      render();
    }
  });
}
audio.addEventListener('playing', () => {
  if (state.current && clearNewEpisode(state.current)) {
    save();
    render();
  }
});
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
