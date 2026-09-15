import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;

    const body = await req.json();
    const questionId = String(body?.question_id ?? "").trim();
    const answerText = String(body?.answer_text ?? "").trim();

    if (!questionId || !answerText) {
      return json({ error: "Вопрос и ответ обязательны" }, 400);
    }
    if (answerText.length > 5000) {
      return json({ error: "Ответ слишком длинный" }, 400);
    }

    const { data: question, error: questionError } = await db
      .from("research_questions")
      .select("id")
      .eq("id", questionId)
      .maybeSingle();

    if (questionError) throw questionError;
    if (!question) return json({ error: "Вопрос не найден" }, 404);

    const { data, error } = await db
      .from("question_answers")
      .insert({
        question_id: questionId,
        submitted_by: auth.user.id,
        answer_text: answerText,
        status: "pending",
      })
      .select("id, question_id, answer_text, status, submitted_at")
      .single();

    if (error) throw error;
    return json({ answer: data }, 201);
  } catch (error) {
    console.error(error);
    return json({ error: "Не удалось сохранить ответ" }, 500);
  }
};
