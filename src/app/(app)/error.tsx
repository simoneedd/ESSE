"use client";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card" role="alert">
      <h1>Qualcosa non ha funzionato</h1>
      <p className="meta">L&apos;errore e&apos; stato registrato senza dati personali. Riprova; se persiste controlla lo stato delle integrazioni.</p>
      <button className="btn primary" type="button" onClick={reset}>Riprova</button>
    </div>
  );
}
