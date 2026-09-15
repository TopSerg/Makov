import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = Netlify.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function publicSupabaseConfig() {
  return {
    url: required("SUPABASE_URL"),
    publishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
  };
}

export function supabaseForRequest(req) {
  const { url, publishableKey } = publicSupabaseConfig();

  const incomingAuth = req.headers.get("authorization");
  const headers = incomingAuth ? { Authorization: incomingAuth } : {};

  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  });
}

export async function requireAuthorizedUser(db) {
  const { data: userData, error: userError } = await db.auth.getUser();
  const user = userData?.user ?? null;

  if (userError || !user) {
    return {
      ok: false,
      response: json({ error: "Authentication required" }, 401),
    };
  }

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error(profileError);
    return {
      ok: false,
      response: json({ error: "Authorization check failed" }, 500),
    };
  }

  if (!profile) {
    return {
      ok: false,
      response: json({ error: "Access has not been granted for this account" }, 403),
    };
  }

  return { ok: true, user, profile };
}

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allowed = ["GET"]) {
  return json({ error: "Method not allowed" }, 405, {
    allow: allowed.join(", "),
  });
}
