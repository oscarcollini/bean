# bean!

Lettore di podcast per Android e browser, installabile come PWA.

[Apri bean!](https://oscarcollini.github.io/bean/)

## Ascolta

Cerca un podcast nel catalogo Apple Italia e seguilo. I podcast seguiti si possono ordinare per titolo o ultima puntata. Tocca «Podcast seguiti» per aprire o richiudere la lista. Il pallino sulla copertina segnala le novità.

Nel lettore puoi cambiare velocità, saltare indietro di 10 secondi o avanti di 30 e aprire le informazioni della puntata. In **Ascolto** trovi le puntate in corso e la coda. Puoi archiviare una puntata già ascoltata o riportarla tra quelle da ascoltare.

## Trasferisci o salva i dati

In **Preferenze**, esporta **OPML** per portare la lista dei podcast in un altro lettore. Usa **Backup JSON** per conservare anche coda, stato di ascolto, posizioni e preferenze. Prima di aggiornare, salva una copia del backup fuori dal browser.

## Pubblica su GitHub Pages

Carica i file nella stessa cartella di pubblicazione, con `index.html` alla radice. Mantieni lo stesso indirizzo dell’app per conservare i dati del browser. Dopo la pubblicazione, chiudi e riapri bean! e controlla la versione nel colophon.

La versione 0.36 tenta l’accesso diretto ai feed e prova l’API di Spreaker per i podcast ospitati lì. Contiene ancora un riferimento a CodeTabs, il cui proxy è stato disattivato. I feed che dipendevano da quel proxy possono restare senza aggiornamenti. L’audio viene riprodotto dal sito che lo ospita.
