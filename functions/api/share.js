/* Cloudflare Pages Function — /api/share
 *
 * Short share links for builds. The planner's plan code (BOP1.…)
 * is too long to paste into chat, so this stores the code under a
 * short random id and hands back a short URL; opening that URL
 * makes the page fetch the code back and load the build exactly
 * as if it had been pasted.
 *
 *   POST /api/share          body: { code: "BOP1.…" }
 *     → 200 { ok: true, id, url }   url is <origin>/?share=<id>
 *   GET  /api/share?id=<id>
 *     → 200 { ok: true, code }
 *     → 404 { ok: false, error }    when the id does not exist
 *
 * Storage is Cloudflare KV through the SHARE_KV binding
 * (env.SHARE_KV) and nothing else — no token, no secret, no
 * account, no identity is stored: just the plan code under the
 * id. Links never expire (no TTL is set on the put). A stored
 * plan is capped at 100 KB; anything bigger is refused with a
 * plain error. If the SHARE_KV binding is not present at
 * runtime, every request answers with a plain error and the
 * page's Copy link button falls back to copying the plan code —
 * nothing here can crash the page.
 *
 * Ids are 8 characters from a URL-safe alphabet with the easily
 * confused characters left out. Before an id is used, the store
 * is checked: an id that already holds a different build is
 * never reused — a fresh id is drawn instead. (Sharing the same
 * build twice simply makes two links to it; both keep working.)
 */

const MAX_PLAN_BYTES = 100 * 1024; // 100 KB
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ID_LENGTH = 8;
const ID_ATTEMPTS = 8;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function newId() {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

async function onRequestPost(context) {
  const env = context.env;
  if (!env || !env.SHARE_KV) {
    return json({ ok: false, error: "Share links are not set up on this site yet." }, 500);
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch (e) {
    return json({ ok: false, error: "The build was not readable." }, 400);
  }

  const code = String((payload && payload.code) || "").trim();
  if (!code) {
    return json({ ok: false, error: "There is no build to share." }, 400);
  }
  if (byteLength(code) > MAX_PLAN_BYTES) {
    return json({ ok: false, error: "That build is too large to share by link." }, 413);
  }

  const origin = new URL(context.request.url).origin;
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt++) {
    const id = newId();
    let existing = null;
    try {
      existing = await env.SHARE_KV.get(id);
    } catch (e) {
      return json({ ok: false, error: "The share store could not be read." }, 502);
    }
    if (existing !== null && existing !== code) continue; // id taken by another build — draw again
    if (existing === null) { // (existing === code would mean this very build already lives under the drawn id — reuse it)
      try {
        await env.SHARE_KV.put(id, code); // no expirationTtl — the link keeps working
      } catch (e) {
        return json({ ok: false, error: "The build could not be stored for sharing." }, 502);
      }
    }
    return json({ ok: true, id: id, url: origin + "/?share=" + id });
  }
  return json({ ok: false, error: "A share link could not be made — please try again." }, 500);
}

async function onRequestGet(context) {
  const env = context.env;
  if (!env || !env.SHARE_KV) {
    return json({ ok: false, error: "Share links are not set up on this site yet." }, 500);
  }

  const id = String(new URL(context.request.url).searchParams.get("id") || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return json({ ok: false, error: "That share link did not open a build." }, 404);
  }

  let code = null;
  try {
    code = await env.SHARE_KV.get(id);
  } catch (e) {
    return json({ ok: false, error: "The share store could not be read." }, 502);
  }
  if (code === null || code === "") {
    return json({ ok: false, error: "That share link did not open a build." }, 404);
  }
  return json({ ok: true, code: code });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  if (context.request.method === "GET") return onRequestGet(context);
  return json({ ok: false, error: "POST or GET only." }, 405);
}
