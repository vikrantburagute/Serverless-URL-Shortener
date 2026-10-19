# Serverless URL Shortener

A URL shortener with click analytics, running entirely on Cloudflare's serverless platform with no servers to manage, deployed for free.

**Live:** https://url-shortener.vuser.workers.dev

## Features

- Short links with random 6-character codes or custom aliases
- Click analytics per link: daily clicks (30 days), countries, referrers, devices and browsers
- Private stats links: each link gets a secret key, shown once at creation
- Admin view to list and delete any link
- Abuse protection: per-IP rate limits, a global daily cap, URL validation and security headers

## Architecture

```
Browser ──► Cloudflare edge
              ├── /, /stats, *.js, *.css  →  Static assets (public/)
              └── everything else         →  Worker (src/index.js)
                                               ├── POST   /api/shorten        create a link
                                               ├── GET    /api/stats/:code    link analytics (stats key)
                                               ├── GET    /api/links          all links (admin key)
                                               ├── DELETE /api/links/:code    delete a link (admin key)
                                               └── GET    /:code              302 redirect + record click
                                                           │
                                                           ▼
                                                     D1 (SQLite)
                                               links · clicks · rate_limits
```

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers |
| Database | Cloudflare D1 (serverless SQLite) |
| Frontend | Plain HTML/CSS/JS, served as Workers Static Assets |
| Scheduled jobs | Cron Triggers (hourly cleanup) |
| Tooling | Wrangler CLI |

### Design decisions

- **D1 instead of KV.** KV's free tier allows only 1,000 writes a day, and each click is a write. D1 allows 100,000 writes a day and supports SQL aggregation for analytics.
- **Clicks are recorded after the redirect** using `ctx.waitUntil`, so analytics never slows a redirect down.
- **302, not 301.** Browsers cache 301 redirects, so repeat clicks would never reach the Worker and wouldn't be counted.
- **Rate limits are counted in D1.** Cloudflare's rate limiting binding is per-location and eventually consistent; in testing it let 40 requests through a limit of 30. A D1 upsert gives an exact count. Click recording still uses the binding, because a strict check there would cost a database write per redirect.
- **Stats keys go in the URL fragment** (`/stats#code=…&key=…`), which browsers never send to the server. The database stores only their SHA-256 hash.
- **No IP addresses are stored.** Rate limit counters are keyed by a hash of the IP and deleted within 2 hours.

## Abuse protection

| Protection | Limit |
|---|---|
| Creating links | 5 per minute and 30 per hour, per IP |
| Viewing stats / admin endpoints | 30 per minute, per IP |
| Recording clicks | ~60 per minute per IP (excess clicks still redirect but aren't counted) |
| New links site-wide | 500 per day (`DAILY_LINK_LIMIT`) |
| URLs | `http(s)` only, at most 2,048 characters, no links back to this site |
| Headers | Strict CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer` (see `public/_headers`) |

## Running locally

Requires Node.js 18+.

```bash
npm install
echo "ADMIN_KEY=some-long-random-string" > .dev.vars   # local admin key, gitignored
npx wrangler d1 migrations apply url-shortener-db --local
npm run dev                                           # http://localhost:8787
```

## Deploying your own copy

```bash
npx wrangler login
npx wrangler d1 create url-shortener-db               # put the printed database_id in wrangler.jsonc
npx wrangler d1 migrations apply url-shortener-db --remote
npx wrangler secret put ADMIN_KEY                      # paste a long random string
npm run deploy
```

## Project structure

```
src/index.js          Worker: routing, link creation, redirects, analytics, rate limiting
public/index.html     Shorten form            public/app.js     its logic
public/stats.html     Analytics dashboard     public/stats.js   its logic and charts
public/style.css      Shared styles (light and dark mode)
public/_headers       Security headers for static pages
migrations/           D1 schema
wrangler.jsonc        Cloudflare configuration
```
