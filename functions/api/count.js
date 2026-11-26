/* Cloudflare Pages Function — GET /api/count
 *
 * Read-only view of the visitor counter written by
 * functions/api/hit.js. It reads the same counters from
 * Cloudflare KV through the existing SHARE_KV binding
 * (env.SHARE_KV) and writes nothing.
 *
 * This is a machine-only endpoint for checking how much the
 * planner is used. It is not linked, referenced or rendered
 * anywhere in the page — no count is ever shown on the site.
 *
 *   GET /api/count
 *     → 200 { ok: true, total: <number>,
 *             today: { date: "<UTC today>", visits: <number> },
 *             days: { "<YYYY-MM-DD>": <visits>, … } }
 *       "days" carries the last 14 UTC days that have a stored
 *       counter (days with no stored key are omitted).
 *     → 405 { ok: false, error } for any other method
 *     → 500/502 { ok: false, error } when the counter store is
 *       missing or cannot be read — a plain JSON error, never
 *       a throw.
 */

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function utcDate(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (daysAgo || 0));
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function toCount(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return json({ ok: false, error: "GET only." }, 405);
  }
  try {
    const env = context.env;
    if (!env || !env.SHARE_KV) {
      return json({ ok: false, error: "The visitor counter is not set up on this site yet." }, 500);
    }
    try {
      const today = utcDate(0);
      const total = toCount(await env.SHARE_KV.get("visits:total"));
      const days = {};
      let todayVisits = 0;
      for (let i = 0; i < 14; i++) {
        const date = utcDate(i);
        const raw = await env.SHARE_KV.get("visits:day:" + date);
        if (raw !== null && raw !== undefined) {
          days[date] = toCount(raw);
          if (date === today) todayVisits = days[date];
        }
      }
      return json({
        ok: true,
        total: total,
        today: { date: today, visits: todayVisits },
        days: days,
      });
    } catch (e) {
      return json({ ok: false, error: "The visitor counter could not be read." }, 502);
    }
  } catch (e) {
    return json({ ok: false, error: "The visitor counter could not be read." }, 502);
  }
}
