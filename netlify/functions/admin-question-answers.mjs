import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;
    if (auth.profile.role !== "admin") return json({ error: "Admin access required" }, 403);

    if (req.method === "GET") {
      const { data: answers, error } = await db
        .from("question_answers")
        .select("id, question_id, submitted_by, answer_text, status, submitted_at, reviewed_at, review_note")
        .order("submitted_at", { ascending: false });

      if (error) throw error;

      const submitterIds = [...new Set((answers ?? []).map(a => a.submitted_by))];
      let profileMap = {};
      if (submitterIds.length) {
        const { data: profiles, error: profileError } = await db
          .from("profiles")
          .select("id, display_name, role")
          .in("id", submitterIds);
        if (profileError) throw profileError;
        profileMap = Object.fromEntries((profiles ?? []).map(p => [p.id, p]));
      }

      return json({
        answers: (answers ?? []).map(a => ({
          ...a,
          submitter: profileMap[a.submitted_by] ?? null,
        })),
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const answerId = body?.answer_id;
      const decision = body?.decision;
      const note = String(body?.note ?? "").trim().slice(0, 1000);

      if (!answerId || !["accepted","rejected"].includes(decision)) {
        return json({ error: "Invalid review request" }, 400);
      }

      const { error } = await db.rpc("review_question_answer", {
        p_answer_id: answerId,
        p_decision: decision,
        p_note: note || null,
      });
      if (error) throw error;

      return json({ ok: true });
    }

    return methodNotAllowed(["GET","POST"]);
  } catch (error) {
    console.error(error);
    return json({ error: "Question answer operation failed" }, 500);
  }
};
