const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const ALIAS_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;
// Paths taken by the API or by static pages (/stats serves stats.html).
const RESERVED = new Set(["api", "admin", "index", "stats"]);
const MAX_URL_LENGTH = 2048;
const STATS_DAYS = 30;
// Strict per-IP limits, counted in D1. Every window must pass.
const RATE_LIMITS = {
  create: [
    { limit: 5, seconds: 60 },
    { limit: 30, seconds: 3600 },
  ],
  stats: [{ limit: 30, seconds: 60 }],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/shorten") {
        if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
        return await shorten(request, env, url);
      }

      const statsMatch = pathname.match(/^\/api\/stats\/([A-Za-z0-9_-]{1,32})$/);
      if (statsMatch) {
        if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
        return await stats(request, env, statsMatch[1]);
      }

      if (pathname === "/api/links" && request.method === "GET") {
        return await listLinks(request, env);
      }

      const deleteMatch = pathname.match(/^\/api\/links\/([A-Za-z0-9_-]{1,32})$/);
      if (deleteMatch && request.method === "DELETE") {
        return await deleteLink(request, env, deleteMatch[1]);
      }

      if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

      // Any other path is treated as a short code: look it up and redirect.
      const code = pathname.slice(1);
      if ((request.method === "GET" || request.method === "HEAD") && ALIAS_PATTERN.test(code)) {
        const link = await env.DB.prepare("SELECT url FROM links WHERE code = ?").bind(code).first();
        if (link) {
          // Record the click after responding so the redirect isn't slowed down.
          ctx.waitUntil(recordClick(request, env, code));
          return Response.redirect(link.url, 302);
        }
      }

      return new Response("Short link not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: "Something went wrong" }, 500);
    }
  },

  // Hourly cron: drop rate limit windows that have expired.
  async scheduled(event, env) {
    const cutoff = Math.floor(Date.now() / 1000) - 2 * 3600;
    await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
  },
};

async function shorten(request, env, url) {
  if (await isRateLimited(env, request, "create")) return tooManyRequests();

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Request body must be JSON" }, 400);
  }

  const longUrl = typeof body.url === "string" ? body.url.trim() : "";
  if (longUrl.length > MAX_URL_LENGTH || !isHttpUrl(longUrl)) {
    return json({ error: "Please provide a valid http(s) URL" }, 400);
  }
  // Short links pointing back at this site could be chained into redirect loops.
  if (new URL(longUrl).hostname === url.hostname) {
    return json({ error: "Links to this site can't be shortened" }, 400);
  }

  const { today } = await env.DB.prepare(
    "SELECT COUNT(*) AS today FROM links WHERE created_at >= date('now')"
  ).first();
  if (today >= Number(env.DAILY_LINK_LIMIT)) {
    return json({ error: "Daily link limit reached, please try again tomorrow" }, 503);
  }

  const statsKey = randomString(24);
  const statsKeyHash = await sha256(statsKey);
  const insert = env.DB.prepare(
    "INSERT INTO links (code, url, stats_key_hash) VALUES (?, ?, ?) ON CONFLICT (code) DO NOTHING"
  );

  let code;
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (alias) {
    if (!ALIAS_PATTERN.test(alias) || RESERVED.has(alias.toLowerCase())) {
      return json({ error: "Alias must be 3-32 characters: letters, numbers, - or _" }, 400);
    }
    const { meta } = await insert.bind(alias, longUrl, statsKeyHash).run();
    if (meta.changes === 0) return json({ error: "That alias is already taken" }, 409);
    code = alias;
  } else {
    code = await insertWithRandomCode(insert, longUrl, statsKeyHash);
  }

  return json(
    {
      code,
      shortUrl: `${url.origin}/${code}`,
      longUrl,
      // The key lives in the URL fragment, which browsers never send to the server.
      statsUrl: `${url.origin}/stats#code=${code}&key=${statsKey}`,
    },
    201
  );
}

async function insertWithRandomCode(insert, longUrl, statsKeyHash) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomString(CODE_LENGTH);
    const { meta } = await insert.bind(code, longUrl, statsKeyHash).run();
    if (meta.changes === 1) return code;
  }
  throw new Error("Could not generate a unique code");
}

async function recordClick(request, env, code) {
  try {
    // Over the limit we still redirect, but don't count it. Stops click inflation
    // and keeps a single client from burning through the D1 write quota.
    // Cloudflare's limiter is approximate, but it costs no database write.
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await env.CLICK_LIMITER.limit({ key: ip })).success) return;

    const userAgent = request.headers.get("User-Agent") || "";
    await env.DB.prepare(
      "INSERT INTO clicks (code, country, referrer, device, browser) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(
        code,
        request.cf?.country ?? null,
        referrerHost(request),
        deviceType(userAgent),
        browserName(userAgent)
      )
      .run();
  } catch (err) {
    console.error("Failed to record click", err);
  }
}

async function stats(request, env, code) {
  if (await isRateLimited(env, request, "stats")) return tooManyRequests();

  const link = await env.DB.prepare(
    "SELECT code, url, stats_key_hash, created_at FROM links WHERE code = ?"
  )
    .bind(code)
    .first();
  const adminView = await isAdmin(request, env);
  // Same response for "no such link" and "wrong key", so codes can't be probed.
  if (!link || !(adminView || (await ownsLink(request, link)))) {
    return json({ error: "Invalid code or stats key" }, 403);
  }

  // `column` is always one of the fixed names below, never user input.
  const breakdown = (column, fallback) =>
    env.DB.prepare(
      `SELECT COALESCE(${column}, ?) AS label, COUNT(*) AS count FROM clicks
       WHERE code = ? GROUP BY label ORDER BY count DESC LIMIT 10`
    ).bind(fallback, code);

  const [total, daily, countries, referrers, devices, browsers] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS count FROM clicks WHERE code = ?").bind(code),
    env.DB.prepare(
      `SELECT date(clicked_at) AS day, COUNT(*) AS count FROM clicks
       WHERE code = ? AND clicked_at >= date('now', ?) GROUP BY day`
    ).bind(code, `-${STATS_DAYS - 1} days`),
    breakdown("country", "Unknown"),
    breakdown("referrer", "Direct"),
    breakdown("device", "Unknown"),
    breakdown("browser", "Unknown"),
  ]);

  return json({
    code: link.code,
    url: link.url,
    createdAt: link.created_at,
    adminView,
    totalClicks: total.results[0].count,
    daily: fillDays(daily.results),
    countries: countries.results,
    referrers: referrers.results,
    devices: devices.results,
    browsers: browsers.results,
  });
}

async function listLinks(request, env) {
  if (await isRateLimited(env, request, "stats")) return tooManyRequests();
  if (!(await isAdmin(request, env))) return json({ error: "Admin key required" }, 403);

  const { results } = await env.DB.prepare(
    `SELECT l.code, l.url, l.created_at AS createdAt, COUNT(c.id) AS clicks
     FROM links l LEFT JOIN clicks c ON c.code = l.code
     GROUP BY l.code ORDER BY l.created_at DESC LIMIT 200`
  ).all();
  return json({ links: results });
}

async function deleteLink(request, env, code) {
  if (await isRateLimited(env, request, "stats")) return tooManyRequests();
  if (!(await isAdmin(request, env))) return json({ error: "Admin key required" }, 403);

  const [, removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM clicks WHERE code = ?").bind(code),
    env.DB.prepare("DELETE FROM links WHERE code = ?").bind(code),
  ]);
  if (removed.meta.changes === 0) return json({ error: "Link not found" }, 404);
  return json({ deleted: code });
}

async function ownsLink(request, link) {
  const key = bearerToken(request);
  return Boolean(key && link.stats_key_hash && (await sha256(key)) === link.stats_key_hash);
}

async function isAdmin(request, env) {
  const key = bearerToken(request);
  // Compare hashes rather than raw strings to avoid leaking the key through timing.
  return Boolean(env.ADMIN_KEY && key && (await sha256(key)) === (await sha256(env.ADMIN_KEY)));
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Cloudflare's rate limiting binding is per-location and eventually consistent; in
// testing it let 40 requests through a limit of 30. D1 gives an exact count instead.
async function isRateLimited(env, request, bucket) {
  const ipHash = await sha256(request.headers.get("CF-Connecting-IP") || "unknown");
  const now = Math.floor(Date.now() / 1000);
  const windows = RATE_LIMITS[bucket];

  const results = await env.DB.batch(
    windows.map(({ seconds }) =>
      env.DB.prepare(
        `INSERT INTO rate_limits (key, window_start) VALUES (?, ?)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
         RETURNING count`
      ).bind(`${bucket}:${seconds}:${ipHash}`, now - (now % seconds))
    )
  );
  return results.some((result, i) => result.results[0].count > windows[i].limit);
}

function tooManyRequests() {
  return json({ error: "Too many requests, please slow down" }, 429, { "Retry-After": "60" });
}

// Last STATS_DAYS days (UTC), oldest first, with zero-click days filled in.
function fillDays(rows) {
  const counts = new Map(rows.map((row) => [row.day, row.count]));
  const days = [];
  for (let i = STATS_DAYS - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, count: counts.get(day) ?? 0 });
  }
  return days;
}

function referrerHost(request) {
  try {
    return new URL(request.headers.get("Referer")).hostname || null;
  } catch {
    return null;
  }
}

function deviceType(userAgent) {
  if (/bot|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python/i.test(userAgent)) {
    return "Bot";
  }
  if (/ipad|tablet/i.test(userAgent)) return "Tablet";
  if (/mobi|android|iphone/i.test(userAgent)) return "Mobile";
  return userAgent ? "Desktop" : "Unknown";
}

function browserName(userAgent) {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/SamsungBrowser/.test(userAgent)) return "Samsung Internet";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

function randomString(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
