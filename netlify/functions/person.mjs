import { supabaseForRequest, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const db = supabaseForRequest(req);
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const slug = url.searchParams.get("slug");

    if (!id && !slug) {
      return json({ error: "Pass ?id=<uuid> or ?slug=<slug>" }, 400);
    }

    let personQuery = db
      .from("persons")
      .select(`
        id, slug, first_name, middle_name, last_name, maiden_name, sex,
        birth_display, death_display, birth_place, death_place, biography,
        is_living, privacy_level, confidence, information_level,
        generation, lineage_path
      `);

    personQuery = id ? personQuery.eq("id", id) : personQuery.eq("slug", slug);

    const { data: person, error: personError } = await personQuery.maybeSingle();

    if (personError) throw personError;
    if (!person) return json({ error: "Person not found or not visible" }, 404);

    const personId = person.id;

    const [
      privateResult,
      relationsResult,
      eventsResult,
      sourcesResult,
      claimsResult,
      mediaResult,
    ] = await Promise.all([
      db
        .from("person_private")
        .select(`
          exact_birth_date, exact_death_date, current_address,
          phone, email, private_notes, privacy_level
        `)
        .eq("person_id", personId)
        .maybeSingle(),

      db
        .from("relationships")
        .select(`
          id, person_a_id, person_b_id, relationship_type,
          note, privacy_level, confidence
        `)
        .or(`person_a_id.eq.${personId},person_b_id.eq.${personId}`),

      db
        .from("events")
        .select(`
          id, event_type, date_from, date_to, date_display, place,
          description, privacy_level, confidence
        `)
        .eq("person_id", personId)
        .order("date_from", { ascending: true, nullsFirst: false }),

      db
        .from("person_sources")
        .select(`
          citation_note,
          source:sources(
            id, title, source_type, archive_name, fond, inventory,
            file_number, page_or_sheet, url, description, reliability_note,
            privacy_level
          )
        `)
        .eq("person_id", personId),

      db
        .from("claims")
        .select(`
          id, subject_person_id, predicate, object_person_id,
          value_text, note, confidence, privacy_level,
          claim_sources(
            note,
            source:sources(
              id, title, source_type, archive_name, fond, inventory,
              file_number, page_or_sheet, url
            )
          )
        `)
        .or(`subject_person_id.eq.${personId},object_person_id.eq.${personId}`)
        .order("created_at", { ascending: false }),

      db
        .from("media")
        .select(`
          id, person_id, source_id, kind, bucket, object_path,
          title, caption, privacy_level, created_at
        `)
        .eq("person_id", personId)
        .order("created_at", { ascending: false }),
    ]);

    const results = [
      privateResult,
      relationsResult,
      eventsResult,
      sourcesResult,
      claimsResult,
      mediaResult,
    ];

    // A public person page must still render even when an optional
    // family/private relation is hidden by RLS.
    return json({
      person,
      private: privateResult.error ? null : (privateResult.data ?? null),
      relationships: relationsResult.error ? [] : (relationsResult.data ?? []),
      events: eventsResult.error ? [] : (eventsResult.data ?? []),
      sources: sourcesResult.error ? [] : (sourcesResult.data ?? []),
      claims: claimsResult.error ? [] : (claimsResult.data ?? []),
      media: mediaResult.error ? [] : (mediaResult.data ?? []),
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Failed to load person" }, 500);
  }
};
