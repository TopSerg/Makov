import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;
    if (auth.profile.role !== "admin") {
      return json({ error: "Admin access required" }, 403);
    }

    if (req.method === "GET") {
      const url = new URL(req.url);
      const status = url.searchParams.get("status") || "pending";

      let query = db
        .from("access_requests")
        .select("id, auth_user_id, email, display_name, message, status, requested_at, reviewed_at, assigned_role, review_note")
        .order("requested_at", { ascending: false });

      if (status !== "all") query = query.eq("status", status);

      const { data, error } = await query;
      if (error) throw error;

      return json({ requests: data ?? [] });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const decision = body?.decision;
      const role = body?.role ?? "reader";
      const note = String(body?.note ?? "").trim().slice(0, 1000);

      if (!body?.request_id || !["approved","rejected"].includes(decision)) {
        return json({ error: "Invalid request" }, 400);
      }
      if (!["reader","editor","admin"].includes(role)) {
        return json({ error: "Invalid role" }, 400);
      }

      const { error } = await db.rpc("review_family_access_request", {
        p_request_id: body.request_id,
        p_decision: decision,
        p_role: role,
        p_note: note || null,
      });

      if (error) throw error;
      return json({ ok: true });
    }

    return methodNotAllowed(["GET","POST"]);
  } catch (error) {
    console.error(error);
    return json({ error: "Access request operation failed" }, 500);
  }
};
