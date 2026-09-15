import { json, methodNotAllowed, publicSupabaseConfig } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const { url, publishableKey } = publicSupabaseConfig();
    return json({ url, publishableKey });
  } catch (error) {
    console.error(error);
    return json({ error: "Authentication configuration unavailable" }, 500);
  }
};
