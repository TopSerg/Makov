import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function supabaseForRequest(req) {
  const url = required("SUPABASE_URL");
  const key = required("SUPABASE_PUBLISHABLE_KEY");

  const incomingAuth = req.headers.get("authorization");
  const headers = incomingAuth ? { Authorization: incomingAuth } : {};

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers },
  });
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
