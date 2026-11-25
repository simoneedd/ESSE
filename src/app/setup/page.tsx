export const metadata = { title: "Configurazione" };

export default function SetupPage() {
  return (
    <main id="contenuto" className="auth">
      <div className="card">
        <h1>Configurazione richiesta</h1>
        <p>Personal OS non è ancora collegato al suo database Supabase dedicato.</p>
        <p className="meta">Imposta NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY (vedi docs/SETUP.md). Nessun dato viene mostrato finché la configurazione non è completa.</p>
      </div>
    </main>
  );
}
