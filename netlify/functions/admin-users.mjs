import { supabaseForRequest, requireAuthorizedUser, json, methodNotAllowed } from "./_supabase.mjs";

const ALLOWED_ROLES = new Set(["reader", "editor", "admin"]);

export default async (req) => {
  try {
    const db = supabaseForRequest(req);
    const auth = await requireAuthorizedUser(db);
    if (!auth.ok) return auth.response;
    if (auth.profile.role !== "admin") {
      return json({ error: "Admin access required" }, 403);
    }

    if (req.method === "GET") {
      const [profilesResult, requestsResult] = await Promise.all([
        db
          .from("profiles")
          .select("id, display_name, role, created_at, updated_at")
          .order("display_name", { ascending: true }),
        db
          .from("access_requests")
          .select("auth_user_id, email, display_name, status, requested_at, reviewed_at, assigned_role")
          .eq("status", "approved")
          .order("reviewed_at", { ascending: false }),
      ]);

      if (profilesResult.error) throw profilesResult.error;
      if (requestsResult.error) throw requestsResult.error;

      const requestByUser = new Map();
      for (const request of requestsResult.data ?? []) {
        if (!requestByUser.has(request.auth_user_id)) {
          requestByUser.set(request.auth_user_id, request);
        }
      }

      const users = (profilesResult.data ?? []).map((profile) => {
        const request = requestByUser.get(profile.id);
        return {
          ...profile,
          email: request?.email ?? null,
        };
      });

      return json({ users });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const userId = String(body?.user_id ?? "").trim();
      const role = String(body?.role ?? "").trim();

      if (!userId || !ALLOWED_ROLES.has(role)) {
        return json({ error: "Invalid user or role" }, 400);
      }

      if (userId === auth.user.id && role !== "admin") {
        return json({ error: "Собственную роль администратора понижать нельзя" }, 400);
      }

      const { data: target, error: targetError } = await db
        .from("profiles")
        .select("id, display_name, role")
        .eq("id", userId)
        .maybeSingle();

      if (targetError) throw targetError;
      if (!target) return json({ error: "User not found" }, 404);

      if (target.role === "admin" && role !== "admin") {
        const { count, error: countError } = await db
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("role", "admin");

        if (countError) throw countError;
        if ((count ?? 0) <= 1) {
          return json({ error: "Нельзя понизить роль последнего администратора" }, 409);
        }
      }

      const { error: updateError } = await db
        .from("profiles")
        .update({ role, updated_at: new Date().toISOString() })
        .eq("id", userId);

      if (updateError) throw updateError;

      const { error: requestUpdateError } = await db
        .from("access_requests")
        .update({ assigned_role: role })
        .eq("auth_user_id", userId)
        .eq("status", "approved");

      if (requestUpdateError) throw requestUpdateError;

      return json({ ok: true, user_id: userId, role });
    }

    return methodNotAllowed(["GET", "POST"]);
  } catch (error) {
    console.error(error);
    return json({ error: "User role operation failed" }, 500);
  }
};
