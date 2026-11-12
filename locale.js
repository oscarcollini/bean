'use strict';

globalThis.appLocale = (() => {
  const english = {
    "Preferenze": "Preferences",
    "Abbonamenti · OPML": "Subscriptions · OPML",
    "Importa o esporta i feed. I podcast già seguiti restano nella lista.": "Import or export feeds. Existing subscriptions stay in the list.",
    "Importa OPML": "Import OPML",
    "Esporta OPML": "Export OPML",
    "Backup completo · JSON": "Full backup · JSON",
    "Include abbonamenti, ascolti, posizione, coda, velocità e ordinamento. Il ripristino sostituisce i dati correnti.": "Includes subscriptions, listening history, progress, queue, speed and sorting. Restoring replaces the current data.",
    "Ripristina backup": "Restore backup",
    "Esporta backup": "Export backup",
    "Il file OPML non è valido.": "The OPML file is invalid.",
    "Il file OPML non contiene feed utilizzabili.": "The OPML file contains no usable feeds.",
    "Il file non è un backup di bean! compatibile.": "This file is not a compatible bean! backup.",
    "Impossibile importare il file.": "Couldn’t import the file.",
    "Questi podcast sono già nella lista.": "These podcasts are already in the list.",
    "Abbonamenti aggiunti: {0}.": "Subscriptions added: {0}.",
    "Sostituire l’archivio corrente con questo backup ({0} podcast)?": "Replace the current library with this backup ({0} podcasts)?",
    "Avvio di bean!…": "Starting bean!…",
    "Controlla archivio": "Check library",
    "Avvio interrotto. Apri «Controlla archivio» per verificare i dati salvati.": "Startup stopped. Open “Check library” to inspect the saved data.",
    "Cerca": "Search",
    "Chiudi": "Close",
    "Installa": "Install",
    "Installa app": "Install app",
    "Risultato": "Result",
    "Riprendi": "Resume",
    "Pausa": "Pause",
    "Copia": "Copy",
    "Riprova": "Try again",
    "In Chrome apri il menu ⋮ e scegli «Aggiungi a schermata Home» o «Installa app», se disponibile.": "Open Chrome’s ⋮ menu and choose “Add to Home screen” or “Install app” if available.",
    "Il browser non ha aperto la richiesta. Riprova dal menu ⋮.": "The browser didn’t open the install prompt. Try again from the ⋮ menu.",
    "Ascolto": "Listening",
    "Aggiorna": "Refresh",
    "Cerca un podcast": "Search for a podcast",
    "Risultati": "Results",
    "Podcast seguiti": "Followed podcasts",
    "Ordina i podcast seguiti": "Sort followed podcasts",
    "Ultima puntata": "Latest episode",
    "Installa bean!": "Install bean!",
    "Coda": "Queue",
    "In corso": "In progress",
    "Pagina della puntata": "Episode page",
    "Apri vista guida": "Open driving view",
    "Chiudi vista guida": "Close driving view",
    "Info puntata": "Episode info",
    "Segna come ascoltato e passa al prossimo episodio in coda": "Mark as played and skip to the next queued episode",
    "Posizione di riproduzione": "Playback position",
    "Indietro di 10 secondi": "Back 10 seconds",
    "Riproduci": "Play",
    "Avanti di 30 secondi": "Forward 30 seconds",
    "Velocità": "Speed",
    "0,75×": "0.75×",
    "1,25×": "1.25×",
    "1,5×": "1.5×",
    "1,75×": "1.75×",
    "Annulla": "Undo",
    "Memoria locale piena o indisponibile.": "Local storage is full or unavailable.",
    "Catalogo non raggiungibile": "Couldn’t reach the catalog",
    "Risposta del catalogo non valida": "Invalid catalog response",
    "Feed non raggiungibile": "Couldn’t reach the feed",
    "Risposta Spreaker non valida": "Invalid Spreaker response",
    "Puntata": "Episode",
    "Indirizzo del feed non valido": "Invalid feed URL",
    "Feed non valido": "Invalid feed",
    "Archiviare questa puntata di ": "Archive this episode of ",
    " e tutte quelle pubblicate fino alla stessa data e ora, comprese quelle che bean! caricherà in futuro?": " and every episode published up to the same date and time, including any episodes bean! loads later?",
    "Puntate archiviate": "Episodes archived",
    "Puntata archiviata": "Episode archived",
    "Nessuna descrizione disponibile per questa puntata.": "No description available for this episode.",
    "Nuova": "New",
    "Riascolta": "Play again",
    "Ascolta": "Play",
    "Già ascoltato": "Played",
    "Altre azioni · ": "More actions · ",
    "Info puntata · ": "Episode info · ",
    "Togli dalla coda": "Remove from queue",
    "Archivia fino a qui": "Archive up to here",
    "Nessuna puntata da riprendere.": "No episodes to resume.",
    "Riprendi ": "Resume ",
    "Segna come ascoltato · ": "Mark as played · ",
    "Ascolta ": "Play ",
    "Metti per prima ": "Move to the front: ",
    "Togli dalla coda ": "Remove from queue: ",
    "Carico le puntate…": "Loading episodes…",
    "Non riesco a caricare le puntate precedenti. Riprova.": "Couldn’t load older episodes. Try again.",
    "Cerca un podcast e premi Segui.": "Find a podcast and tap Follow.",
    "Nuove puntate": "New episodes",
    "Opzioni · ": "Options · ",
    "Smetti di seguire": "Unfollow",
    "Smettere di seguire «": "Unfollow «",
    "Smetti di seguire ": "Unfollow ",
    "Nessuna puntata da ascoltare.": "No episodes to play.",
    "Mostra puntate precedenti": "Show older episodes",
    "Mostra puntate precedenti · ": "Show older episodes · ",
    "Puntate archiviate (": "Archived episodes (",
    "Mostra altre puntate archiviate": "Show more archived episodes",
    "Mostra altre puntate archiviate · ": "Show more archived episodes · ",
    "Segui un podcast per aggiornare le puntate.": "Follow a podcast to refresh its episodes.",
    "Aggiorno le puntate…": "Refreshing episodes…",
    "Feed non raggiungibili: {0} su {1}.": "Couldn’t reach {0} of {1} feeds.",
    "Puntate aggiornate.": "Episodes updated.",
    "Cerco nel catalogo…": "Searching the catalog…",
    "Nessun podcast trovato.": "No podcasts found.",
    "Seguito": "Following",
    "Segui": "Follow",
    "Non riesco a leggere il feed di questo podcast.": "Couldn’t read this podcast’s feed.",
    "Ricerca non disponibile. Riprova tra poco.": "Search is unavailable. Try again shortly.",
    "Riproduzione non disponibile. Tocca Play per riprovare.": "Playback is unavailable. Tap Play to try again.",
    "Audio non disponibile per questa puntata.": "Audio is unavailable for this episode.",
    "Da ascoltare": "Mark as unplayed",
    "In coda": "Add to queue",
    "La coda è vuota.": "The queue is empty."
  };
  const preference = navigator.language || navigator.languages?.[0] || 'it';
  const language = /^it(?:-|$)/i.test(preference) ? 'it' : 'en';
  const locale = /^(?:it|en)(?:-|$)/i.test(preference) ? preference : 'en';
  const text = (source, ...values) => {
    const message = language === 'en' && Object.hasOwn(english, source) ? english[source] : source;
    return values.length ? message.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]) : message;
  };

  document.documentElement.lang = language;
  if (language === 'en') {
    document.querySelector('link[rel="manifest"]').href = "bean-en.webmanifest?v=035";
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('script, style')) continue;
      const source = node.data.trim();
      if (Object.hasOwn(english, source)) node.data = node.data.replace(source, () => text(source));
    }
    for (const element of document.querySelectorAll('[aria-label], [alt], [placeholder], [title]')) {
      for (const attribute of ['aria-label', 'alt', 'placeholder', 'title']) {
        if (element.hasAttribute(attribute)) element.setAttribute(attribute, text(element.getAttribute(attribute)));
      }
    }
    for (const link of document.querySelectorAll('a[rel~="license"], a[href*="creativecommons.org/licenses/"]')) {
      link.href = link.href.replace(/deed\.it$/, 'deed.en');
    }
  }
  return { text, locale };
})();
