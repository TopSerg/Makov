import { createRemoteJWKSet, jwtVerify } from "npm:jose@6.1.0";

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_AUDIENCE = "makov-archive-radar";
const GITHUB_REPOSITORY = "TopSerg/Makov";
const GITHUB_WORKFLOW_PREFIX =
  "TopSerg/Makov/.github/workflows/archive-radar.yml@";
const JWKS = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks"),
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function authorize(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("missing bearer token");
  const token = auth.slice(7);
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: GITHUB_ISSUER,
    audience: GITHUB_AUDIENCE,
  });

  if (payload.repository !== GITHUB_REPOSITORY) {
    throw new Error("unexpected repository");
  }
  if (payload.ref !== "refs/heads/main") {
    throw new Error("unexpected ref");
  }
  const workflowRef = String(payload.workflow_ref || "");
  if (!workflowRef.startsWith(GITHUB_WORKFLOW_PREFIX)) {
    throw new Error("unexpected workflow");
  }
  const event = String(payload.event_name || "");
  if (!["schedule", "workflow_dispatch", "push"].includes(event)) {
    throw new Error("unexpected event");
  }
}

function getAdminKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) throw new Error("No Supabase admin key in Edge Function env");
  const parsed = JSON.parse(raw);
  if (!parsed.default) throw new Error("No default Supabase secret key");
  return parsed.default;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ADMIN_KEY = getAdminKey();

async function db(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", ADMIN_KEY);
  headers.set("content-type", "application/json");
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers,
  });
}

function normalizeHtml(input: string) {
  return input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

async function sha256(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function insertRow(table: string, row: Record<string, unknown>) {
  const res = await db(table, {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`${table} insert failed: ${res.status} ${await res.text()}`);
}

async function updateTarget(id: string, patch: Record<string, unknown>) {
  const res = await db(`monitoring_targets?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`target update failed: ${res.status} ${await res.text()}`);
}

async function processTarget(target: any) {
  const checkedAt = new Date();
  const nextCheckAt = new Date(
    checkedAt.getTime() + Number(target.check_interval_hours || 24) * 3600_000,
  );
  let httpStatus: number | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    let response = await fetch(String(target.source_url), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6",
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (response.status === 403 || response.status === 429) {
      response = await fetch(`https://r.jina.ai/${String(target.source_url)}`, {
        headers: {
          accept: "text/plain,text/markdown;q=0.9,*/*;q=0.5",
          "x-no-cache": "true",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    }

    clearTimeout(timeout);
    httpStatus = response.status;

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 5_000_000) {
      throw new Error(`response too large: ${contentLength} bytes`);
    }

    const raw = await response.text();
    if (raw.length > 5_000_000) throw new Error("response body too large");
    const normalized = normalizeHtml(raw);
    const contentHash = await sha256(normalized);

    const matcher = target.matcher || {};
    const patterns = asArray(matcher.patterns);
    const matched = patterns.filter((pattern) =>
      normalized.includes(normalizeHtml(pattern))
    );

    const oldMatches = new Set(asArray(target.last_match));
    const newMatches = matched.filter((pattern) => !oldMatches.has(pattern));

    let newStatus = "waiting";
    if (patterns.length > 0 && matched.length === patterns.length) {
      newStatus = "found";
    } else if (matched.length > 0) {
      newStatus = "partial";
    }

    await insertRow("monitoring_checks", {
      target_id: target.id,
      checked_at: checkedAt.toISOString(),
      http_status: httpStatus,
      success: true,
      content_hash: contentHash,
      matched_patterns: matched,
      error: null,
    });

    const patch: Record<string, unknown> = {
      status: newStatus,
      last_checked_at: checkedAt.toISOString(),
      last_http_status: httpStatus,
      last_content_hash: contentHash,
      last_match: matched,
      next_check_at: nextCheckAt.toISOString(),
      updated_at: checkedAt.toISOString(),
    };
    if (newStatus === "found" && !target.found_at) {
      patch.found_at = checkedAt.toISOString();
    }
    await updateTarget(target.id, patch);

    if (newMatches.length > 0 || target.status !== newStatus) {
      await insertRow("monitoring_hits", {
        target_id: target.id,
        detected_at: checkedAt.toISOString(),
        old_status: target.status,
        new_status: newStatus,
        new_matches: newMatches,
        snapshot: {
          url: target.source_url,
          matched_count: matched.length,
          expected_count: patterns.length,
          content_hash: contentHash,
        },
      });
    }

    return {
      id: target.id,
      name: target.name,
      status: newStatus,
      matched: matched.length,
      expected: patterns.length,
      new_matches: newMatches,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await insertRow("monitoring_checks", {
      target_id: target.id,
      checked_at: checkedAt.toISOString(),
      http_status: httpStatus,
      success: false,
      matched_patterns: [],
      error: message.slice(0, 2000),
    });
    await updateTarget(target.id, {
      last_checked_at: checkedAt.toISOString(),
      last_http_status: httpStatus,
      next_check_at: nextCheckAt.toISOString(),
      updated_at: checkedAt.toISOString(),
    });
    return { id: target.id, name: target.name, status: target.status, error: message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    await authorize(req);
  } catch (error) {
    return json(
      { error: "unauthorized", detail: error instanceof Error ? error.message : String(error) },
      401,
    );
  }

  const res = await db("monitoring_targets?select=*&enabled=eq.true");
  if (!res.ok) {
    return json({ error: "db_read_failed", detail: await res.text() }, 500);
  }
  const targets = await res.json();
  const now = Date.now();
  const due = targets.filter((target: any) => {
    if (target.status === "found" || target.status === "paused") return false;
    if (!target.next_check_at) return true;
    return new Date(target.next_check_at).getTime() <= now;
  });

  const results = [];
  for (const target of due.slice(0, 50)) {
    results.push(await processTarget(target));
  }

  return json({
    ok: true,
    checked: results.length,
    skipped: targets.length - due.length,
    remaining_due: Math.max(0, due.length - 50),
    results,
  });
});
