# Pōhutukawa Coast Times — website

Static site, built with [Eleventy](https://www.11ty.dev/). Designed to deploy to Netlify with a lightweight Git-backed CMS (added in Phase 2).

## Run it locally

```bash
npm install
npm start
```

Then open <http://localhost:8080>.

## Build for production

```bash
npm run build
```

Outputs to `_site/`.

## Project layout

```
src/
├── _data/          # YAML data — edited via the CMS in Phase 2
├── _includes/      # Layouts + partials (header, footer)
├── assets/         # CSS, JS, images — passes through to /assets
├── files/          # PDFs (issues, rate card) — passes through to /files
└── *.njk           # Page templates
```

## Phase status

- **Phase 1** — static mock-up with placeholder PDFs. ✅ done
- **Phase 2 (this)** — Sveltia CMS at `/admin`, schema, Netlify config. ✅ done
- **Phase 3** — Netlify deploy, OAuth setup, real content, domain swap.

## Testing the CMS locally

`/admin` is just static HTML served by Eleventy. With `npm start`, the admin page
loads at <http://localhost:8080/admin/> but cannot write to disk without a small
proxy. To enable local content editing:

```bash
# In a separate terminal — leave it running:
npx @sveltia/cms-proxy-server
```

Then refresh `/admin`. Sveltia will detect the proxy and write changes directly
to the local YAML / PDF / image files.

For production, **Sveltia CMS uses the GitHub backend** (PKCE OAuth, no GitHub
OAuth App registration needed). Editors log in with their GitHub account, and
saves commit directly to the connected repo. Update `src/admin/config.yml`
`backend.repo:` to your real repo path before deploying.

> **Why not Netlify git-gateway?** Sveltia CMS does not support git-gateway —
> only Decap CMS does. We use Sveltia's native GitHub backend instead.

## Editor handover

See [EDITOR_GUIDE.md](./EDITOR_GUIDE.md) for the plain-English guide written for
Leanne. That's what she follows each Friday.
