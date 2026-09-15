import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;

    const [questionsResult, answersResult] = await Promise.all([
      db
        .from("research_questions")
        .select("id, family_line, subject, question, ask_or_verify, priority, status, channel, why_needed, related_record, legacy_answer, updated_at")
        .order("id", { ascending: true }),
      db
        .from("question_answers")
        .select("id, question_id, submitted_by, answer_text, status, submitted_at, reviewed_at, review_note")
        .order("submitted_at", { ascending: false }),
    ]);

    if (questionsResult.error) throw questionsResult.error;
    if (answersResult.error) throw answersResult.error;

    return json({
      questions: questionsResult.data ?? [],
      answers: answersResult.data ?? [],
      viewer: {
        id: auth.user.id,
        display_name: auth.profile.display_name ?? null,
        role: auth.profile.role,
      },
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Failed to load research questions" }, 500);
  }
};
