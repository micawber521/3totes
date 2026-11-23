# 3totes.com

Placeholder site for 3totes (tote rentals, Southeast Missouri). Nests under SEMO Sell, LLC.
This repo is PUBLIC: never commit an email address, token or key.

- `public/`: static site
- `worker.js`: serves `public/` and handles the contact form (`POST /api/contact`), relaying
  submissions through Proton SMTP submission. The destination email is never exposed to visitors.
  Form is hidden until the SMTP secrets are set.
- `wrangler.json`: deploy config; custom domains 3totes.com + www

## Worker secrets (Cloudflare dashboard, Worker > Settings > Variables and Secrets)
| Name | Purpose |
|---|---|
| `CONTACT_EMAIL` | where submissions are delivered |
| `SMTP_USER` | Proton custom-domain address the SMTP token belongs to (the sender) |
| `SMTP_TOKEN` | Proton SMTP token (Proton > Settings > IMAP/SMTP > SMTP tokens) |
| `SMTP_SERVER` | optional, default smtp.protonmail.ch |
| `SMTP_PORT` | optional, default 587 (STARTTLS); 465 = implicit TLS |
| `TURNSTILE_SITE_KEY` | optional, enables Cloudflare Turnstile anti-spam |
| `TURNSTILE_SECRET` | required with `TURNSTILE_SITE_KEY` |

Deploys automatically on push to `main` (Cloudflare Workers Builds: build `npm run build`, deploy `npx wrangler deploy`).
- `public/logo.svg`: hand-drawn SVG, three stacked totes.

## Admin (`/admin`) — booking back office, step 1
- `src/admin.js`: schedule, bookings (manual entry), kits, settings. Server-rendered, no payments yet.
- `src/db.js`: D1 schema. The Worker applies pending migrations itself on the first admin request.
- `src/access.js`: verifies the Cloudflare Access JWT inside the Worker. **Fails closed:** with no
  Access config the admin returns 503; any other auth problem returns 403.

Setup (Cloudflare dashboard):
1. D1 database named `3totes`, bound to this Worker as `DB` (binding in `wrangler.json`).
2. Zero Trust > Access > Applications: self-hosted app for `3totes.com/admin*`, Allow policy by email.
3. Worker secrets:

| Name | Purpose |
|---|---|
| `ACCESS_TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | Access application's Audience (AUD) tag |
| `OWNER_EMAILS` | comma-separated, full admin |
| `DRIVER_EMAILS` | optional, comma-separated, schedule only |
