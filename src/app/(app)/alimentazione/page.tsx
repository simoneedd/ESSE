import { SubmitButton } from "@/components/SubmitButton";
import { Card, Empty, Flash, PageHeader, readSp, Stat, type SP } from "@/components/ui";
import { MEAL_LABEL } from "@/lib/domain";
import { isoWeekday, mealsForDay, type MealItem } from "@/lib/planning";
import { requireUser } from "@/lib/session";
import { dayBoundsUtc, formatTime } from "@/lib/time";
import { addShopping, addWater, clearShopping, importMealPlan, logMeal, toggleShopping } from "./actions";

export const metadata = { title: "Alimentazione" };

export default async function FoodPage({ searchParams }: { searchParams: SP }) {
  const sp = await readSp(searchParams);
  const { db, today, tz } = await requireUser();
  const { start, end } = dayBoundsUtc(today, tz);
  const [plan, logs, water, shopping] = await Promise.all([
    db.from("meal_plans").select("id, name, author, meal_plan_items(weekday, slot, time_hint, description)").eq("active", true).limit(1).maybeSingle(),
    db.from("meal_logs").select("id, slot, description, eaten_at, followed_plan").gte("eaten_at", start.toISOString()).lt("eaten_at", end.toISOString()).order("eaten_at"),
    db.from("hydration_logs").select("ml").gte("logged_at", start.toISOString()).lt("logged_at", end.toISOString()),
    db.from("shopping_items").select("id, name, quantity, checked").order("checked").order("created_at"),
  ]);
  const items = (plan.data?.meal_plan_items ?? []) as MealItem[];
  const todayMeals = mealsForDay(items, isoWeekday(today, tz));
  const ml = (water.data ?? []).reduce((a, w) => a + w.ml, 0);
  return (
    <>
      <PageHeader title="Alimentazione" sub="Piano del professionista, diario, idratazione e spesa." />
      <Flash sp={sp} />
      <p className="notice" style={{ marginBottom: 16 }}>Personal OS non crea diete ne&apos; fornisce indicazioni nutrizionali o mediche: mostra il piano che importi (es. redatto dal tuo nutrizionista) e ti ricorda i pasti. Questi dati non vengono mai condivisi con IronEdge.</p>
      <div className="bento">
        <Card className="w-8" title={plan.data ? `Oggi dal piano "${plan.data.name}"` : "Piano alimentare"}>
          {plan.data ? (
            todayMeals.length ? <ul className="list">{todayMeals.map((m, i) => <li key={i}><b style={{ minWidth: 90 }}>{MEAL_LABEL[m.slot]}</b><span className="grow">{m.description}</span><span className="meta">{m.time_hint?.slice(0, 5) ?? ""}</span></li>)}</ul> : <Empty>Il piano non prevede voci per oggi.</Empty>
          ) : <Empty>Nessun piano importato. Lo scheduler usa orari standard per i pasti, senza contenuti.</Empty>}
          {plan.data?.author ? <p className="meta">Autore: {plan.data.author}</p> : null}
        </Card>
        <Card className="w-4" title="Idratazione">
          <Stat value={`${(ml / 1000).toFixed(1)} L`} label="oggi" />
          <div className="row">{[250, 500].map((v) => <form key={v} action={addWater}><input type="hidden" name="ml" value={v} /><button className="btn small" type="submit">+{v} ml</button></form>)}</div>
          <p className="meta">Nessun obiettivo preimpostato: se il professionista te ne ha indicato uno, annotalo nel piano.</p>
        </Card>

        <Card className="w-6" title="Diario di oggi">
          {logs.data?.length ? <ul className="list">{logs.data.map((l) => <li key={l.id}><b style={{ minWidth: 90 }}>{MEAL_LABEL[l.slot]}</b><span className="grow">{l.description}</span><span className="meta">{formatTime(l.eaten_at, tz)}{l.followed_plan === true ? " · da piano" : l.followed_plan === false ? " · fuori piano" : ""}</span></li>)}</ul> : <Empty>Nessun pasto registrato oggi.</Empty>}
          <form action={logMeal} className="stack">
            <div className="form-grid">
              <label>Pasto<select name="slot" defaultValue="lunch">{Object.entries(MEAL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Ora<input type="time" name="time" /></label>
              <label>Seguito il piano?<select name="followed" defaultValue=""><option value="">—</option><option value="yes">Si&apos;</option><option value="no">No</option></select></label>
            </div>
            <label>Cosa hai mangiato<input name="description" required maxLength={1000} /></label>
            <SubmitButton>Registra</SubmitButton>
          </form>
        </Card>
        <Card className="w-6" title="Lista della spesa" action={<form action={clearShopping}><button className="btn ghost small" type="submit">Rimuovi presi</button></form>}>
          {shopping.data?.length ? <ul className="list">{shopping.data.map((s) => (
            <li key={s.id}>
              <form action={toggleShopping}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="checked" value={s.checked ? "0" : "1"} /><button className={`habit-cell ${s.checked ? "on" : ""}`} style={{ width: 22, height: 22 }} type="submit" aria-label={`${s.name}: ${s.checked ? "preso" : "da prendere"}`} /></form>
              <span className="grow" style={s.checked ? { textDecoration: "line-through", color: "var(--text-3)" } : undefined}>{s.name}</span>
            </li>
          ))}</ul> : <Empty>Lista vuota.</Empty>}
          <form action={addShopping} className="row"><input name="name" placeholder="es. avena, yogurt, spinaci" required maxLength={2000} className="grow" style={{ width: "auto" }} /><SubmitButton className="btn small">Aggiungi</SubmitButton></form>
        </Card>

        <Card className="w-12" title="Importa piano alimentare (CSV)">
          <form action={importMealPlan} className="stack">
            <div className="form-grid">
              <label>Nome<input name="name" maxLength={120} placeholder="Piano novembre" /></label>
              <label>Redatto da<input name="author" maxLength={120} placeholder="es. Dott.ssa Rossi, nutrizionista" /></label>
              <label>File CSV<input type="file" name="file" accept=".csv,text/csv" /></label>
            </div>
            <label>Oppure incolla il contenuto<textarea name="csv" placeholder={"giorno;pasto;orario;descrizione\ntutti;colazione;07:30;Yogurt greco e avena\nlun;pranzo;13:00;Riso basmati e pollo"} /></label>
            <SubmitButton>Importa e attiva</SubmitButton>
          </form>
          <p className="meta">Colonne: giorno (lun…dom o &quot;tutti&quot;), pasto (colazione, pranzo, cena, spuntino), orario (HH:MM), descrizione. Le righe non valide vengono scartate e segnalate, mai completate automaticamente.</p>
        </Card>
      </div>
    </>
  );
}
