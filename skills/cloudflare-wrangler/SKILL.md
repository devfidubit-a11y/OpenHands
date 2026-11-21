---
name: cloudflare-wrangler
description: "Cloudflare Workers, Pages and OpenNext with Wrangler. Use for wrangler.jsonc/toml config, bindings (KV, D1, R2, Durable Objects, Queues, Hyperdrive, AI), local dev, type generation, secrets, preview and production deploys, and Next.js on Cloudflare via @opennextjs/cloudflare."
---

# Cloudflare with Wrangler

`wrangler` is installed in the container. It authenticates with
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment. Never
run `wrangler login`, and never print or commit those values.

## Golden rules

1. **Deploys and secrets need the user's explicit consent** for that exact
   command and environment: `wrangler deploy`, `versions deploy`, `pages
   deploy`, `secret put/delete`, `d1 execute --remote`, `kv key put/delete
   --remote`, `r2 object delete`, `queues delete`, and any `--env production`.
   Prefer previews: `wrangler versions upload` or a staging `--env`. Show the
   user the preview URL first.
2. **Remote data is production data.** Use `--local` for D1/KV/R2 while
   developing. Write D1 migrations as files (`wrangler d1 migrations create`),
   apply them `--local` first, and apply them `--remote` only with consent.
3. **Don't reinstall dependencies in a host-mounted project.** A project
   under `/documents` or `/projects` whose `node_modules` was installed on
   macOS has native binaries (workerd, esbuild, sharp) that won't run in this
   Linux container. Running `npm install` there would break the user's own
   setup. Instead, work in a worktree, which has no `node_modules`, and install
   there:
   ```bash
   safe-branch start <slug> --worktree && cd ../<repo>-<slug>
   npm ci            # or pnpm install --frozen-lockfile, matching the lockfile
   ```
4. Read `wrangler.jsonc` / `wrangler.toml` before changing anything. Keep
   `compatibility_date` and flags unless the task is to update them.

## Everyday commands

```bash
wrangler whoami                         # check the token and account
wrangler types                          # regenerate Env types after binding changes
wrangler dev --local                    # local Worker with local bindings
wrangler deploy --dry-run --outdir dist # build and validate without deploying
wrangler versions upload                # preview version, no traffic (consent still nice)
wrangler tail <worker> --format pretty  # live logs (read-only)
wrangler d1 migrations apply <DB> --local
```

## Next.js on Cloudflare (OpenNext)

Projects with `@opennextjs/cloudflare` and `open-next.config.ts`:

```bash
npx opennextjs-cloudflare build         # build the Worker bundle
npx opennextjs-cloudflare preview       # run it locally with workerd
npx opennextjs-cloudflare deploy        # deploy: needs consent
```

Use the project's own scripts (`npm run preview`, `npm run deploy`,
`npm run cf-typegen`) when they exist, because they may set flags. Check
Node-compat requirements (`nodejs_compat` flag) and the bundle size limits.
Static assets go through the `ASSETS` binding.

## Config checklist when reviewing

- Bindings in config match the `Env` type (run `wrangler types`) and the code.
- No secrets in `vars`. Secrets come from `wrangler secret`, and `.dev.vars`
  locally (git-ignored).
- Routes and custom domains are correct per environment. `workers_dev` is
  intended.
- Observability (`observability.enabled`) and sensible `limits`.
- Cron triggers, queues, and Durable Object migrations (`migrations` with
  `new_sqlite_classes`) are versioned correctly.

## Report

Say what you ran (local vs remote), the preview URL or version ID, what still
needs the user's consent to go live, and how to roll back
(`wrangler rollback` or `versions deploy <previous-id>`).
