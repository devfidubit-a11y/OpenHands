---
name: docker-containers
description: "Expert in Docker and containers. Use to dockerize an app (Dockerfile, .dockerignore, multi-stage builds), write Compose files, run isolated test environments (databases, services, the app itself) in throwaway containers, debug containers, harden and slim images, and prepare or perform container deployments."
---

# Docker and containers

You have a **private Docker engine** (`DOCKER_HOST=tcp://docker:2375`):
Docker-in-Docker, isolated from the user's machine. Use it freely for builds
and tests. Nothing you run there can see or touch the user's own containers.
If `docker info` fails, the engine is off: tell the user to set
`COMPOSE_PROFILES=docker` and `AGENT_DOCKER_HOST=tcp://docker:2375` in `.env`.

## How the private engine behaves

- Containers run inside the `docker` service. Their published ports are
  reached at **`docker:<port>`**, not `localhost:<port>`. For example, after
  `docker run -p 5432:5432 postgres`, connect to `docker:5432`.
- Bind mounts work for paths under `/projects` and `/documents`, which are
  mounted at the same paths there. Other paths in your container don't exist
  inside the engine. Use `docker cp`, or build them into the image.
- Images and volumes persist in the engine between conversations. Clean up
  what you created (`docker rm -f`, `docker compose down -v`), and label
  resources (`--label agent=<name>`) so cleanup is precise.
- Pin image tags (`postgres:17.6`, `node:24.22-slim`), never `latest`.

## Dockerizing an app

1. Read the app first: runtime and version, build and start commands, ports,
   env vars, writable paths, native dependencies, and health endpoint.
2. **Multi-stage Dockerfile:** a `deps` stage (install with the lockfile),
   a `build` stage, and a slim `runtime` stage that holds only what's needed
   to run.
3. Best practices:
   - Order layers for cache: copy lockfiles, install, then copy the source.
   - Use a `.dockerignore`: `node_modules`, `.git`, `.env*`, build output, logs.
   - Run as a non-root `USER`, with `HEALTHCHECK`, `EXPOSE`, and exec-form
     `CMD`/`ENTRYPOINT`.
   - No secrets in the image (`ARG`/`ENV` with keys, or copied `.env`). Use
     runtime env or BuildKit `--secret`.
   - Handle signals (tini or `init: true`), log to stdout and stderr, and keep
     the app stateless so data goes in volumes.
   - Next.js: `output: "standalone"`. Node: `npm ci --omit=dev` in runtime.
     Python: `uv`/`pip` with `--no-cache-dir`.
4. Build and check: `docker build -t app:test .`, then `docker run --rm -p
   3000:3000 app:test`, then curl `docker:3000`. Check the image size
   (`docker images`) and the user (`docker run --rm app:test id`).

## Isolated testing

- **Throwaway dependencies:** start real Postgres, Redis, MinIO, and the like
  with Compose (a `compose.test.yml`), wait for health, run the tests against
  `docker:<port>`, then `docker compose -p test-<slug> down -v`.
- **Test the app in its container:** run the qa-testing smoke and E2E suites
  against the running image. That's what production will run.
- **Testcontainers** works too: set `TESTCONTAINERS_HOST_OVERRIDE=docker`.
- Use a unique Compose project name per agent (`-p <agent>-<slug>`) so
  parallel agents don't collide.

## Compose

Pin versions; set `healthcheck` and `depends_on: condition: service_healthy`;
use named volumes for data; set `restart` policies; use env files that stay
out of git; publish ports only when needed; set resource limits for heavy
services. Validate with `docker compose config`.

## Deploying containers

- Building and testing locally is free. **Pushing images, deploying, or
  changing a server needs the user's explicit consent** (change-safety-guard):
  `docker push`, `docker compose up` on a remote host or `docker context`,
  Kubernetes `apply`, and registry logins.
- Tag images immutably (git SHA or version), and scan them (`docker scout
  cves` or Trivy) before you propose a push.
- Provide a rollback (the previous tag) and a post-deploy smoke test.
- For Cloudflare, use the cloudflare-wrangler skill. Workers aren't
  containers.

## Report

The Dockerfile and Compose changes, image size and user, test results run in
containers, what you cleaned up, and anything that still needs consent to
deploy.
