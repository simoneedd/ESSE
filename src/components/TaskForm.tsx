import { SubmitButton } from "@/components/SubmitButton";
import { createTask } from "@/app/(app)/task/actions";
import { AREA_LABEL, LIFE_AREAS, PRIORITY_LABEL, type LifeArea } from "@/lib/domain";

export function TaskForm({ back, area, clientId, clients }: { back: string; area?: LifeArea; clientId?: string; clients?: { id: string; name: string }[] }) {
  return (
    <form action={createTask} className="stack">
      <input type="hidden" name="back" value={back} />
      {clientId ? <input type="hidden" name="client_id" value={clientId} /> : null}
      <label>Titolo<input name="title" required maxLength={200} /></label>
      <div className="form-grid">
        <label>Area<select name="area" defaultValue={area ?? "personal"}>{LIFE_AREAS.filter((a) => a !== "ironedge").map((a) => <option key={a} value={a}>{AREA_LABEL[a]}</option>)}</select></label>
        <label>Priorita&apos;<select name="priority" defaultValue="3">{[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></label>
        <label>Durata (min)<input type="number" name="estimated" min={5} max={1440} step={5} placeholder="30" /></label>
        <label>Scadenza<input type="date" name="due" /></label>
        <label>Ricorrenza<select name="recurrence" defaultValue=""><option value="">Nessuna</option><option value="daily">Giornaliera</option><option value="weekdays">Feriali</option><option value="weekly">Settimanale</option><option value="monthly">Mensile</option></select></label>
        <label>Riprogrammazione<select name="auto" defaultValue=""><option value="">Secondo l&apos;area</option><option value="yes">Autonoma</option><option value="no">Chiedi sempre</option></select></label>
      </div>
      {clients && !clientId ? <label>Cliente<select name="client_id" defaultValue=""><option value="">—</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label> : null}
      <label>Categoria<input name="category" maxLength={80} placeholder="es. contenuti, report" /></label>
      <label>Descrizione<textarea name="description" maxLength={8000} /></label>
      <label className="check"><input type="checkbox" name="fixed" /> Impegno fisso (non spostabile dall&apos;assistente)</label>
      <SubmitButton>Crea task</SubmitButton>
    </form>
  );
}

