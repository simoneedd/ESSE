"use server";
import { z } from "zod";
import { num, optStr, run, str } from "@/lib/action";
import { parseMealPlanCsv } from "@/lib/planning";
import { must } from "@/lib/session";
import { zonedToUtc } from "@/lib/time";

/** Import di un piano redatto da un professionista: nessuna elaborazione nutrizionale, solo trascrizione. */
export async function importMealPlan(fd: FormData) {
  await run("/alimentazione", async ({ db, user }) => {
    const name = str(fd, "name", 120) || "Piano alimentare";
    const file = fd.get("file");
    let text = str(fd, "csv", 200_000);
    if (file instanceof File && file.size) {
      if (file.size > 200_000) throw new Error("File troppo grande (max 200 KB)");
      text = await file.text();
    }
    const { items, errors } = parseMealPlanCsv(text);
    if (!items.length) throw new Error(errors[0] ?? "Nessuna riga valida");
    await db.from("meal_plans").update({ active: false }).eq("active", true);
    const plan = must(await db.from("meal_plans").insert({ user_id: user.id, name, author: optStr(fd, "author", 120), source: "import_csv", active: true }).select("id").single());
    must(await db.from("meal_plan_items").insert(items.map((i) => ({ ...i, user_id: user.id, plan_id: plan.id }))));
    return `Piano importato: ${items.length} voci${errors.length ? `, ${errors.length} righe scartate` : ""}`;
  });
}

export async function logMeal(fd: FormData) {
  await run("/alimentazione", async ({ db, user, profile, today }) => {
    const description = str(fd, "description", 1000);
    if (!description) throw new Error("Descrizione obbligatoria");
    const followed = str(fd, "followed", 5);
    must(await db.from("meal_logs").insert({
      user_id: user.id, slot: z.enum(["breakfast", "lunch", "dinner", "snack"]).parse(fd.get("slot")), description,
      eaten_at: zonedToUtc(today, str(fd, "time", 5) || "13:00", profile.timezone).toISOString(), followed_plan: followed === "yes" ? true : followed === "no" ? false : null, note: optStr(fd, "note", 500),
    }));
    return "Pasto registrato nel diario";
  });
}

export async function addWater(fd: FormData) {
  await run("/alimentazione", async ({ db, user }) => {
    const ml = num(fd, "ml");
    if (!ml || ml < 1 || ml > 3000) throw new Error("Quantita' non valida");
    must(await db.from("hydration_logs").insert({ user_id: user.id, ml: Math.round(ml) }));
    return `+${Math.round(ml)} ml`;
  });
}

export async function addShopping(fd: FormData) {
  await run("/alimentazione", async ({ db, user }) => {
    const names = str(fd, "name", 2000).split(/[\n,]/).map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!names.length) throw new Error("Inserisci almeno un prodotto");
    must(await db.from("shopping_items").insert(names.map((n) => ({ user_id: user.id, name: n.slice(0, 120) }))));
    return "Lista aggiornata";
  });
}

export async function toggleShopping(fd: FormData) {
  await run("/alimentazione", async ({ db }) => {
    const id = z.uuid().parse(fd.get("id"));
    must(await db.from("shopping_items").update({ checked: fd.get("checked") === "1" }).eq("id", id));
    return "Aggiornato";
  });
}

export async function clearShopping() {
  await run("/alimentazione", async ({ db }) => {
    must(await db.from("shopping_items").delete().eq("checked", true));
    return "Prodotti presi rimossi";
  });
}
