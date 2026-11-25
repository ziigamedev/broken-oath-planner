/* Cloudflare Pages Function — POST /api/report
 *
 * Receives a "Report a problem" submission from the planner page and
 * files it as a GitHub issue in ziigamedev/broken-oath-planner with
 * the "bug" label, so the visitor never has to leave the page or
 * hold a GitHub account.
 *
 * The GitHub token is read from the environment (env.GITHUB_TOKEN,
 * set as a secret on the Cloudflare Pages project). It is never
 * hard-coded here and never sent to the browser.
 *
 * Expected JSON body:
 *   {
 *     what:      string  — what went wrong (required)
 *     tab:       string  — the tab the report is about
 *     gameData:  string  — game data version line
 *     planner:   string  — planner version, e.g. "v286"
 *     buildCode: string  — optional plan/build code
 *     screenshot: null | { name, type, data }  — optional image,
 *                 data is the base64 payload (no data: prefix)
 *   }
 *
 * A screenshot cannot be attached to an issue through the GitHub
 * API directly, so it is committed to the repo under
 * report-screenshots/ via the Contents API and embedded in the
 * issue body from its download URL. If that upload fails, the
 * issue is still filed, the body says the screenshot could not
 * be attached, and it quotes the real GitHub error (HTTP status
 * and message) on its own line so the cause is visible — a bare
 * "upload failed" hides whether it was the token's permissions,
 * the file size, or something else entirely.
 *
 * Success: 200 { ok: true, url, number }
 * Failure: 4xx/5xx { ok: false, error } — the page then falls
 * back to copying the report and opening the GitHub issue form.
 */

const REPO = "ziigamedev/broken-oath-planner";
const MAX_SCREENSHOT_BYTES = 1 * 1024 * 1024; // 1 MB decoded — the Contents API refuses larger files

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cleanName(name) {
  const base = String(name || "screenshot.png").split(/[\\/]/).pop();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return cleaned || "screenshot.png";
}

async function gh(env, path, options) {
  const res = await fetch("https://api.github.com" + path, {
    method: (options && options.method) || "GET",
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "broken-oath-planner-report",
      "Content-Type": "application/json",
    },
    body: options && options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data: data, text: text };
}

/* GitHub's error responses carry a human-readable "message"
 * (and sometimes an "errors" list). Pull both out so a failure
 * can be quoted verbatim instead of guessed at. Falls back to
 * the raw body when the response was not the usual JSON. */
function ghErrorDetail(r) {
  const parts = [];
  if (r && r.data && r.data.message) parts.push(String(r.data.message));
  if (r && r.data && Array.isArray(r.data.errors) && r.data.errors.length) {
    const extra = r.data.errors.map(function (e) {
      return [e.resource, e.field, e.code].filter(Boolean).join(" ");
    }).filter(Boolean).join("; ");
    if (extra) parts.push(extra);
  }
  if (!parts.length && r && r.text) parts.push(String(r.text).slice(0, 300));
  return parts.join(" — ").slice(0, 600) || "no error detail returned";
}

export async function onRequestPost(context) {
  const env = context.env;
  if (!env || !env.GITHUB_TOKEN) {
    return json({ ok: false, error: "The report service is not configured yet." }, 500);
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch (e) {
    return json({ ok: false, error: "The report was not readable." }, 400);
  }

  const what = String(payload.what || "").trim().slice(0, 5000);
  if (!what) {
    return json({ ok: false, error: "The report text is empty." }, 400);
  }
  const tab = String(payload.tab || "Home").slice(0, 60);
  const gameData = String(payload.gameData || "").slice(0, 120);
  const planner = String(payload.planner || "").slice(0, 40);
  const buildCode = String(payload.buildCode || "").trim().slice(0, 20000);

  /* Screenshot first, so its link can go into the issue body. */
  let shotLine = "None";
  let shotEmbed = "";
  let shotError = "";
  const shot = payload.screenshot;
  if (shot && shot.data && String(shot.type || "image/").indexOf("image/") === 0) {
    const approxBytes = Math.floor(String(shot.data).length * 3 / 4);
    if (approxBytes > MAX_SCREENSHOT_BYTES) {
      shotLine = "Provided, but too large to attach";
    } else {
      try {
        const path = "report-screenshots/" + Date.now() + "-" + cleanName(shot.name);
        const up = await gh(env, "/repos/" + REPO + "/contents/" + path.split("/").map(encodeURIComponent).join("/"), {
          method: "PUT",
          body: { message: "Screenshot from a problem report", content: String(shot.data) },
        });
        if (up.ok && up.data && up.data.content && up.data.content.download_url) {
          shotLine = "Attached below";
          shotEmbed = "\n![Screenshot](" + up.data.content.download_url + ")\n";
        } else {
          shotLine = "Provided, but the upload failed";
          shotError = "GitHub HTTP " + up.status + ": " + ghErrorDetail(up);
        }
      } catch (e) {
        shotLine = "Provided, but the upload failed";
        shotError = "Upload request never completed: " + String((e && e.message) || e).slice(0, 300);
      }
    }
  }

  const firstLine = what.split("\n")[0];
  const title = "Problem on " + tab + (firstLine ? ": " + firstLine.slice(0, 60) : "");
  const body =
    "## What went wrong\n" + what + "\n\n" +
    "- **Tab:** " + tab + "\n" +
    "- **Game data:** " + gameData + "\n" +
    "- **Planner:** " + planner + "\n" +
    "- **Build code:** " + (buildCode ? "\n```\n" + buildCode + "\n```" : "Not included") + "\n" +
    "- **Screenshot:** " + shotLine + "\n" +
    (shotError ? "- **Screenshot upload error:** " + shotError + "\n" : "") +
    shotEmbed;

  let issue;
  try {
    issue = await gh(env, "/repos/" + REPO + "/issues", {
      method: "POST",
      body: { title: title, body: body, labels: ["bug"] },
    });
  } catch (e) {
    return json({ ok: false, error: "GitHub could not be reached." }, 502);
  }
  if (!issue.ok || !issue.data || !issue.data.html_url) {
    return json({ ok: false, error: "GitHub refused the report." }, 502);
  }

  return json({ ok: true, url: issue.data.html_url, number: issue.data.number });
}

export async function onRequest(context) {
  if (context.request.method === "POST") return onRequestPost(context);
  return json({ ok: false, error: "POST only." }, 405);
}
