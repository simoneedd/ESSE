# Costi — nessun servizio a pagamento attivato

Fonti: tabella costi di IronEdge (verificata su fonti ufficiali il 2026-11-25) e listino Anthropic (riferimento SDK, novembre 2026). Da riverificare prima di ogni attivazione.

| Servizio | Piano | Note per Personal OS | Costo |
|---|---|---|---|
| Supabase | Free (limite di 2 progetti Free attivi: verificare nel tuo account) | Secondo progetto dopo IronEdge staging; 500 MB DB bastano per anni di dati personali. La pausa per inattività non scatta grazie al cron | 0 € (Pro 25 $/mese solo se servono backup gestiti) |
| Vercel | Hobby | Uso personale: compatibile con i termini Hobby | 0 € |
| GitHub Actions | Repo pubblico: illimitato · privato: 2.000 min/mese | Cron 15 min ≈ 2.900 job/mese (ok su pubblico; su privato usare 30 min ≈ 1.450) + CI/scansioni | 0 € |
| Google Calendar API | Gratuita entro quote | Uso personale lontano dai limiti | 0 € |
| Telegram Bot API | Gratuita | — | 0 € |
| Anthropic API | A consumo, **disattivata** | Solo richieste non riconosciute dai comandi. Stima per richiesta (~3.000 token in / 300 out): Opus 5.5 ≈ 0,018 $, Sonnet 5.5 ≈ 0,009 $, Haiku 5.5 ≈ 0,0005 $. Tetto: `AI_MONTHLY_BUDGET_USD` + `AI_MAX_REQUESTS_PER_DAY` verificati su DB | 0 € finché non autorizzi |

Totale attuale: **0 €**. Attivazioni a pagamento (AI, Supabase Pro, GitHub Pro per protezione branch) richiedono la tua decisione.
