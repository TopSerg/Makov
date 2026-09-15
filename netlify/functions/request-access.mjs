import { supabaseForRequest, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  try {
    const body = await req.json();
    const userId = body?.user_id;
    const email = String(body?.email ?? "").trim();
    const displayName = String(body?.display_name ?? "").trim().slice(0, 120);
    const message = String(body?.message ?? "").trim().slice(0, 1000);

    if (!userId || !email) {
      return json({ error: "Некорректная заявка" }, 400);
    }

    const db = supabaseForRequest(req);
    const { data, error } = await db.rpc("request_family_access", {
      p_user_id: userId,
      p_email: email,
      p_display_name: displayName || null,
      p_message: message || null,
    });

    if (error) {
      console.error(error);
      return json({ error: "Не удалось отправить заявку" }, 400);
    }

    return json({ ok: true, request_id: data }, 201);
  } catch (error) {
    console.error(error);
    return json({ error: "Не удалось отправить заявку" }, 500);
  }
};
