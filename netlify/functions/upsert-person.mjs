import { supabaseForRequest, json, methodNotAllowed } from "./_supabase.mjs";

const allowedPersonFields = new Set([
  "slug", "first_name", "middle_name", "last_name", "maiden_name", "sex",
  "birth_display", "death_display", "birth_place", "death_place", "biography",
  "is_living", "privacy_level", "confidence", "information_level",
  "generation", "lineage_path", "layout_order"
]);

const allowedPrivateFields = new Set([
  "exact_birth_date", "exact_death_date", "current_address",
  "phone", "email", "private_notes", "privacy_level"
]);

function pick(input, allowed) {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([key]) => allowed.has(key))
  );
}

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  try {
    const db = supabaseForRequest(req);
    const body = await req.json();

    const id = body.id ?? null;
    const personPayload = pick(body.person, allowedPersonFields);

    if (!id && !personPayload.first_name) {
      return json({ error: "person.first_name is required for a new person" }, 400);
    }

    let savedPerson;

    if (id) {
      const { data, error } = await db
        .from("persons")
        .update(personPayload)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      savedPerson = data;
    } else {
      const { data, error } = await db
        .from("persons")
        .insert(personPayload)
        .select()
        .single();

      if (error) throw error;
      savedPerson = data;
    }

    let savedPrivate = null;

    if (body.private) {
      const privatePayload = {
        ...pick(body.private, allowedPrivateFields),
        person_id: savedPerson.id,
      };

      const { data, error } = await db
        .from("person_private")
        .upsert(privatePayload, { onConflict: "person_id" })
        .select()
        .single();

      if (error) throw error;
      savedPrivate = data;
    }

    return json({ person: savedPerson, private: savedPrivate }, id ? 200 : 201);
  } catch (error) {
    console.error(error);

    // RLS/permission failures intentionally stay generic.
    return json({ error: "Save failed or you do not have permission" }, 403);
  }
};
