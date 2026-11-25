import Link from "next/link";

export default function NotFound() {
  return (
    <main id="contenuto" className="auth">
      <div className="card"><h1>Pagina non trovata</h1><Link className="btn" href="/">Torna alla dashboard</Link></div>
    </main>
  );
}
