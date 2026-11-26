/* Cloudflare Pages Function — POST /api/hit
 *
 * First-party visitor counter (privacy-light). The planner page
 * sends a tiny fire-and-forget beacon to this endpoint, and this
 * function adds one to two counters in Cloudflare KV through
 * the existing SHARE_KV binding (env.SHARE_KV) — the same
 * binding functions/api/share.js uses; no new binding, no
 * token, no secret.
 *
 * What it counts: one count per browser session per page visit,
 * sent by the page beacon. The page only sends it on the live
 * site address, and only once per browser session.
 *
 * What it stores — and what it never stores: the only values
 * ever written are two plain decimal counts, under the keys
 * "visits:total" and "visits:day:<YYYY-MM-DD>" (the UTC date of
 * the request). NOTHING about the visitor is stored: no IP
 * address, no user agent, no referrer, no path, and no cookie
 * is set or read. The "visits:" prefix also means these keys
 * can never collide with a share id (share ids are 8 characters
 * from a letters+digits alphabet with no ":").
 *
 * Known limit: KV has no atomic increment, so this is a
 * read-modify-write — under heavy concurrency two requests can
 * read the same value and one increment can be lost. That is
 * acceptable for an aggregate counter like this one.
 *
 *   POST /api/hit
 *     → 204 (no body) on success
 *     → 405 { ok: false, error } for any other method
 *     → 500/502 { ok: false, error } when the counter store is
 *       missing or cannot be read/written — a plain JSON error,
 *       never a throw, so a failed count can never break the page
 *       (the beacon ignores the response anyway).
 */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function utcToday() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

async function bump(kv, key) {
  const raw = await kv.get(key);
  const n = parseInt(raw, 10);
  const next = (Number.isFinite(n) && n >= 0 ? n : 0) + 1;
  await kv.put(key, String(next));
  return next;
}

export async function onRequest(context) {
  if (context.request.method !== "POST") {
    return json({ ok: false, error: "POST only." }, 405);
  }
  try {
    const env = context.env;
    if (!env || !env.SHARE_KV) {
      return json({ ok: false, error: "The visitor counter is not set up on this site yet." }, 500);
    }
    try {
      await bump(env.SHARE_KV, "visits:total");
      await bump(env.SHARE_KV, "visits:day:" + utcToday());
    } catch (e) {
      return json({ ok: false, error: "The visitor counter could not be updated." }, 502);
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    return json({ ok: false, error: "The visitor counter could not be updated." }, 502);
  }
}
