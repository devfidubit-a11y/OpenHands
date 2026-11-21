---
name: qa-testing
description: "QA engineer that reviews and tests code. Use to review a change or project and write and run tests: unit tests, integration tests, component tests, end-to-end (E2E) tests, snapshot tests, and visual regression tests, with Vitest/Jest/node:test, Testing Library, Playwright, MSW, and Storybook. Also for flaky tests, coverage gaps, and test strategy."
---

# QA: review and test the code

Find what is untested and risky, write the tests that would catch real bugs,
run them, and report honestly what passed, failed, or couldn't be run.

## 1. Review first

- Read the change (`git diff` against the base) or the feature's code, and
  list its behaviors, edge cases, and failure modes: empty, invalid, too
  large, concurrent, slow network, permission denied, offline.
- Find the existing test setup and **use it**: the runner and config
  (`vitest.config`, `jest.config`, `playwright.config`, `node --test` in
  `package.json`), helpers, fixtures, and naming. Don't add a second test
  framework when one exists. Propose it to the user only if nothing fits.
- Rank risks: money, auth, data loss, and core user flows first.

## 2. Pick the right level (test pyramid)

| Type | What it proves | Typical tools | Keep it |
| --- | --- | --- | --- |
| **Unit** | Pure logic: functions, reducers, validators, formatters | Vitest, Jest, `node:test` | Many, fast, no I/O |
| **Integration** | Modules working together: API handler + DB, service + queue | Vitest/Jest + real DB (Docker/Testcontainers, D1/Miniflare `--local`), MSW for external HTTP | Fewer, real boundaries |
| **Component** | A UI component's behavior through its public API | Testing Library (`@testing-library/react`), Vitest browser mode, Playwright CT, Storybook interaction tests | Test what users see and do, not internals |
| **E2E** | Critical user journeys in a real browser against a running app | Playwright (Chromium is installed in the container) | A handful of happy paths and key failures |
| **Snapshot** | Serialized output doesn't change unexpectedly | `toMatchSnapshot` / `toMatchInlineSnapshot` | Small and reviewed; never snapshot huge trees |
| **Visual regression** | Pixels didn't change unexpectedly | Playwright `expect(page).toHaveScreenshot()`, Storybook + test-runner | Stable data, fixed viewport, animations off |

## 3. Writing good tests

- Arrange → Act → Assert, with one behavior per test and a name that states
  it ("rejects an expired OTP").
- Test behavior through public interfaces. Query the UI by role and label
  (`getByRole('button', { name: 'Pagar' })`), not CSS classes or test IDs
  unless there's no better hook.
- Cover the edge cases and errors you listed, not only the happy path.
- Deterministic: fake timers and dates, seeded data, no real network (MSW),
  no sleeps; wait for conditions instead. Isolate state between tests.
- Mock at the boundary (HTTP, clock, payment provider), not the module under
  test.
- Each new test must fail without the fix: break the code briefly, or reason
  it through explicitly.

### E2E (Playwright)

- Use the app's existing `webServer` config, or start the app first. Use
  `baseURL`, roles, and web-first assertions (`await expect(locator).toBeVisible()`).
- Log in through an API or storage state, not the UI, in every test.
- Collect traces on failure (`trace: 'on-first-retry'`). If browsers are
  missing, run `npx playwright install chromium`.

### Snapshot and visual regression

- First run creates baselines. Show the user the new baseline images or
  snapshots and get them approved before committing.
- Update baselines (`-u` / `--update-snapshots`) only when the change is
  intended, and say so. Never update them just to make tests pass.
- For visuals, fix the viewport, fonts, locale, timezone, and data, disable
  animations, and mask dynamic regions (dates, avatars). Baselines are
  OS-specific: generate them in the same environment as CI (this Linux
  container), and keep thresholds tight (`maxDiffPixelRatio` around 0.01).

## 4. Run and report

Run the narrowest set first, then the whole suite, plus lint and type check.
In host-mounted projects, follow the cloudflare-wrangler rule: don't reinstall
dependencies in the user's checkout; use a worktree (`safe-branch start <slug>
--worktree`) and install there.

Report as a table: test type, file, cases added, and result. Then list
failures with the cause (bug in the code or in the test), coverage gaps you
didn't close, and flaky or skipped tests and why. Never claim a test passed
unless you ran it.
