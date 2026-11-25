# Personal OS — Design System

Identità **indipendente da IronEdge** (IronEdge: neutri zinco + rosso #F30201). Personal OS: neutri pietra caldi + verde petrolio, tono calmo e "da benessere". Ispirazione di qualità (gerarchia, spaziature, densità controllata) da Apple, Linear e Notion senza riprenderne elementi riconoscibili.

## Marchio
- Nome: **Esse** · sottotitolo "Personal OS". Monogramma "E" geometrico su quadrato arrotondato (`public/icon.svg`, PNG generati da `scripts/build-icons.py`).
- Nessun asset di terze parti, nessun font remoto: stack di sistema (SF Pro su Apple, Segoe UI Variable su Windows, Roboto su Android). Zero richieste a terzi dal browser.

## Token (in `src/app/globals.css`)
| Token | Chiaro | Scuro | Uso |
|---|---|---|---|
| `--bg` | #F7F6F2 | #0F0F0E | sfondo |
| `--surface` / `--elevated` | #FFFFFF / #F0EEE8 | #171715 / #1F1F1C | card / hover |
| `--border` / `--border-input` | #E4E1D8 / #8F8B80 | #2A2A26 / #77746B | separatori / campi (≥3:1) |
| `--text` / `--text-2` / `--text-3` | #1C1B18 / #57544C / #6B685F | #F2F1EC / #B0ADA3 / #949186 | primario / secondario / meta |
| `--accent` (+ `--accent-contrast`) | #1F6F63 (testo bianco) | #5CC4B0 (testo #0B1A17) | azioni primarie |
| `--accent-text` / `--accent-soft` | #1A6458 / #E2EFEC | #74D2C0 / #15302B | link, stato attivo |
| `--positive` `--warning` `--danger` | #2F7D32 #A55A00 #B42318 | #6CC070 #F0A54A #F2796D | esiti |

Colori per area (sempre accompagnati da etichetta testuale, mai unico veicolo di significato): Personale viola, Marketing arancio, Trading blu, IronEdge ambra, Palestra rosa, Studio verde, Benessere teal.

Contrasti (WCAG 2.2 AA, calcolati sui token): testo primario ≥ 15.8:1 in entrambi i temi; secondario ≥ 6.9:1; meta ≥ 5.1:1; esiti (positivo/avviso/errore) ≥ 4.7:1; bordi dei campi ≥ 3.1:1; bianco su `--accent` chiaro 5.98:1; #0B1A17 su `--accent` scuro 8.5:1.

## Forme e ritmo
Raggi 8 / 14 / 20 px · spaziatura base 4 px (gap 6-12-16) · ombre leggere solo in chiaro · numeri tabulari ovunque (orari, durate).

## Componenti (`src/components`)
| Componente | Regola |
|---|---|
| `Card` (`accent`, `flush`) | `accent` solo per l'elemento più importante della vista (assistente, proposte) |
| Bento grid (`.bento`, `w-3/4/6/8/12`, `h-2`) | 12 colonne → 6 → 1 su mobile |
| `Timeline` | barra colorata per area; blocchi fissi su fondo pieno, pause/margini tratteggiati; linea "adesso" rossa |
| `Badge`, `AreaTag` | stati brevi, mai frasi |
| `MinuteBars`, `Sparkline`, `Progress` | **senza dati mostrano un messaggio**, mai zeri inventati |
| `.week` calendario | 7 colonne con scroll orizzontale interno (mai della pagina) |
| `.habit-grid` | 7 giorni, caselle toggle con `aria-pressed` |
| Chat `.msg` | utente a destra in accent, assistente a sinistra; risposte AI marcate "Generato con AI" |

## Regole di contenuto
- Italiano, frasi brevi, verbi d'azione. Nessuna statistica senza fonte nei dati; "dati insufficienti" quando mancano.
- Mai dichiarare operativo ciò che non lo è: integrazioni mostrano "non configurato"; la sveglia nativa è dichiarata non disponibile.
- Nessun incentivo al sovraccarico: i messaggi suggeriscono di ridurre, rimandare, proteggere il sonno.

## Accessibilità e responsive
Link "Vai al contenuto", focus visibile 2 px, un `h1` per pagina, `aria-live` per esiti, `aria-current` in navigazione, controlli ≥ 32-40 px, `prefers-reduced-motion`, nessun overflow orizzontale da 320 px (verificato con Playwright su iPhone 13). Navigazione: sidebar ≥ 900 px, tab bar inferiore con safe-area su mobile.

## Temi
Segue il sistema; scelta manuale salvata solo nel browser (`localStorage`), applicata prima del rendering con script nonce-CSP.
