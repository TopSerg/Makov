import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;

    const [peopleResult, relationsResult] = await Promise.all([
      db
        .from("persons")
        .select(`
          id, slug, first_name, middle_name, last_name, maiden_name, sex,
          birth_display, death_display, birth_place, death_place,
          is_living, privacy_level, confidence, information_level,
          generation, lineage_path, layout_order
        `)
        .order("last_name", { ascending: true })
        .order("first_name", { ascending: true }),

      db
        .from("relationships")
        .select(`
          id, person_a_id, person_b_id, relationship_type,
          note, privacy_level, confidence
        `),
    ]);

    if (peopleResult.error) throw peopleResult.error;
    if (relationsResult.error) throw relationsResult.error;

    return json({
      people: peopleResult.data ?? [],
      relationships: relationsResult.data ?? [],
      viewer: {
        email: auth.user.email ?? null,
        display_name: auth.profile.display_name ?? null,
        role: auth.profile.role
      }
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Failed to load tree" }, 500);
  }
};
