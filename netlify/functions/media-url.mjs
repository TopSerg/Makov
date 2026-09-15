import { supabaseForRequest, json, methodNotAllowed } from "./_supabase.mjs";

export default async (req) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  try {
    const db = supabaseForRequest(req);
    const url = new URL(req.url);
    const mediaId = url.searchParams.get("id");

    if (!mediaId) return json({ error: "Pass ?id=<media uuid>" }, 400);

    const { data: media, error } = await db
      .from("media")
      .select("id, bucket, object_path, privacy_level")
      .eq("id", mediaId)
      .maybeSingle();

    if (error) throw error;
    if (!media) return json({ error: "Media not found or not visible" }, 404);

    if (media.bucket === "genealogy-public") {
      const { data } = db.storage.from(media.bucket).getPublicUrl(media.object_path);
      return json({ url: data.publicUrl, expires_in: null });
    }

    const { data, error: signedError } = await db.storage
      .from(media.bucket)
      .createSignedUrl(media.object_path, 300);

    if (signedError) throw signedError;

    return json({ url: data.signedUrl, expires_in: 300 });
  } catch (error) {
    console.error(error);
    return json({ error: "Failed to create media URL" }, 500);
  }
};
