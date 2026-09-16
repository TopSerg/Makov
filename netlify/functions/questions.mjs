import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;

    const [branchesResult, questionsResult, answersResult] = await Promise.all([
      db
        .from("research_branches")
        .select("id, name, family_side, progress_summary, status, sort_order, updated_at")
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      db
        .from("research_questions")
        .select("id, branch_id, family_line, subject, question, ask_or_verify, priority, status, channel, why_needed, related_record, legacy_answer, updated_at")
        .order("id", { ascending: true }),
      db
        .from("question_answers")
        .select("id, question_id, submitted_by, answer_text, status, submitted_at, reviewed_at, review_note, accounted_at, accounted_note")
        .order("submitted_at", { ascending: false }),
    ]);

    if (branchesResult.error) throw branchesResult.error;
    if (questionsResult.error) throw questionsResult.error;
    if (answersResult.error) throw answersResult.error;

    return json({
      branches: branchesResult.data ?? [],
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
