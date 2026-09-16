import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;
    if (auth.profile.role !== "admin") return json({ error: "Admin access required" }, 403);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const scope = url.searchParams.get("scope") || "open";

      const { data: rawAnswers, error: answersError } = await db
        .from("question_answers")
        .select("id, question_id, submitted_by, answer_text, status, submitted_at, reviewed_at, review_note, accounted_at, accounted_note")
        .order("submitted_at", { ascending: false });
      if (answersError) throw answersError;

      const answers = rawAnswers ?? [];
      const questionIds = [...new Set(answers.map(a => a.question_id))];
      const submitterIds = [...new Set(answers.map(a => a.submitted_by))];

      let questions = [], profiles = [], branches = [];
      if (questionIds.length) {
        const qr = await db
          .from("research_questions")
          .select("id, branch_id, subject, question")
          .in("id", questionIds);
        if (qr.error) throw qr.error;
        questions = qr.data ?? [];
      }
      if (submitterIds.length) {
        const pr = await db
          .from("profiles")
          .select("id, display_name, role")
          .in("id", submitterIds);
        if (pr.error) throw pr.error;
        profiles = pr.data ?? [];
      }
      const branchIds = [...new Set(questions.map(q => q.branch_id).filter(Boolean))];
      if (branchIds.length) {
        const br = await db
          .from("research_branches")
          .select("id, name")
          .in("id", branchIds);
        if (br.error) throw br.error;
        branches = br.data ?? [];
      }

      const qMap = Object.fromEntries(questions.map(q => [q.id, q]));
      const pMap = Object.fromEntries(profiles.map(p => [p.id, p]));
      const bMap = Object.fromEntries(branches.map(b => [b.id, b]));

      const enriched = answers.map(a => {
        const q = qMap[a.question_id] ?? null;
        return {
          ...a,
          question: q,
          branch: q?.branch_id ? (bMap[q.branch_id] ?? null) : null,
          submitter: pMap[a.submitted_by] ?? null,
        };
      });

      const visible = scope === "all"
        ? enriched
        : enriched.filter(a =>
            a.status === "pending"
            || (a.status === "accepted" && !a.accounted_at)
          );

      return json({
        answers: visible,
        counts: {
          pending: enriched.filter(a => a.status === "pending").length,
          accepted_unaccounted: enriched.filter(a => a.status === "accepted" && !a.accounted_at).length,
          accounted: enriched.filter(a => a.status === "accepted" && a.accounted_at).length,
          rejected: enriched.filter(a => a.status === "rejected").length,
        },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const answerId = body?.answer_id;
      const action = body?.action;
      const note = String(body?.note ?? "").trim().slice(0, 1000);

      if (!answerId || !["accept","reject","account"].includes(action)) {
        return json({ error: "Invalid inbox action" }, 400);
      }

      if (action === "account") {
        const { error } = await db.rpc("mark_question_answer_accounted", {
          p_answer_id: answerId,
          p_note: note || null,
        });
        if (error) throw error;
      } else {
        const { error } = await db.rpc("review_question_answer", {
          p_answer_id: answerId,
          p_decision: action === "accept" ? "accepted" : "rejected",
          p_note: note || null,
        });
        if (error) throw error;
      }

      return json({ ok: true });
    }

    return methodNotAllowed(["GET","POST"]);
  } catch (error) {
    console.error(error);
    return json({ error: "Answer inbox operation failed" }, 500);
  }
};
