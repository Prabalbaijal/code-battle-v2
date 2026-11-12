# Security pass: OWASP ASVS 4.0 Level 1

Phase 6 (plan §16, §25). Each row is either met (✅, with where), a deliberate deviation (⚖️, with
why), a gap to close before or at launch (⚠️), or not applicable (—). Re-check this list when auth,
uploads or the edge change.

Last reviewed: 2026-11-12, against `main` after Phase 5.

## V2 Authentication

| #     | Requirement                                    | Status | How / where                                                                                                                                                    |
| ----- | ---------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.1 | Passwords ≥ 12 characters                      | ⚖️     | Minimum is **8** (`PASSWORD_MIN_LENGTH`, NIST 800-63B allows 8). Raising new and reset passwords to 12 is a one-line change; v1 users keep theirs until reset. |
| 2.1.2 | Passwords up to at least 64 characters allowed | ✅     | Max 128 (`PASSWORD_MAX_LENGTH`).                                                                                                                               |
| 2.1.7 | Checked against breached passwords             | ⚠️     | Not yet. Plan: HIBP k-anonymity range check (5 hash characters leave the server, fail-open) at register and reset, before launch.                              |
| 2.1.9 | No composition rules                           | ✅     | Length only (`lib/form.ts`, identity zod schemas).                                                                                                             |
| 2.2.1 | Anti-automation on credential endpoints        | ✅     | Login 5/min per IP+account and 20/min per IP; register 10/h per IP; email endpoints limited (`auth.rate-limits.ts`); lockout 15 min after 10 failures.         |
| 2.4.1 | Passwords stored with an approved slow hash    | ✅     | Argon2id m=19456 KiB, t=2, p=1 (`modules/auth/crypto.ts`); v1 bcrypt hashes are rehashed to Argon2id on login.                                                 |
| 2.5.1 | Recovery secret not sent in clear / single-use | ✅     | Reset tokens: 256-bit random, stored hashed, 30 min, single use; reset revokes every refresh token of the user.                                                |
| 2.5.2 | No password hints or secret questions          | ✅     | None.                                                                                                                                                          |
| 2.5.4 | No shared or default accounts                  | ✅     | Admins are promoted users; no seeded credentials in production.                                                                                                |
| 2.7   | Out-of-band verifier (email link)              | ✅     | Email verification tokens: random, hashed, 24 h, single use. Same response for unknown emails (no enumeration).                                                |

## V3 Session management

| #     | Requirement                              | Status | How / where                                                                                                 |
| ----- | ---------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 3.1.1 | Session tokens never in URLs             | ✅     | Cookies only; the socket uses a single-use 60 s ticket in the handshake body, not the URL.                  |
| 3.2.1 | New token on authentication              | ✅     | Login issues a fresh access token and refresh family.                                                       |
| 3.2.3 | Tokens stored safely in the browser      | ✅     | `cb_at` / `cb_rt` are HttpOnly, Secure (`COOKIE_SECURE`), SameSite=Lax; nothing in localStorage.            |
| 3.3.1 | Logout invalidates the session           | ✅     | Logout revokes the refresh family and clears the cookies; access tokens live 15 min.                        |
| 3.3.2 | Re-authentication after a period         | ✅     | Refresh tokens expire after 30 days and rotate on every use; a reused token revokes the whole family.       |
| 3.4.x | Cookie attributes                        | ✅     | `HttpOnly`, `Secure`, `SameSite=Lax`, refresh cookie scoped to `/api/v1/auth` (`auth.routes.ts`).           |
| 3.5.2 | Stateless tokens are signed and verified | ✅     | EdDSA JWTs with `kid`, verified against JWKS by every service; internal calls use short-lived HS256 tokens. |

## V4 Access control

| #     | Requirement                         | Status | How / where                                                                                                                                           |
| ----- | ----------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1.1 | Enforced on a trusted service layer | ✅     | Gateway route table (`apps/gateway/src/routes.ts`) **and** every service checks the token itself.                                                     |
| 4.1.3 | Least privilege                     | ✅     | Roles user / problem_setter / admin; one Postgres role per service, owning only its database.                                                         |
| 4.2.1 | No IDOR                             | ✅     | Reads and writes are scoped to the token's user (notifications, ledger, tab lease, submissions); match intake checks participation server-side.       |
| 4.2.2 | CSRF protection                     | ✅     | `x-cb-csrf: 1` required on cookie-authenticated mutations + `Origin` check at the gateway + SameSite=Lax.                                             |
| 4.3.1 | Admin interfaces protected          | ✅     | `/admin/*` needs problem_setter/admin at the edge and in problem/judge services; `/internal/*` never routed by the gateway and needs a service token. |

## V5 Validation, sanitisation and encoding

| #     | Requirement                                  | Status | How / where                                                                                                 |
| ----- | -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 5.1.3 | All input validated (allow-lists)            | ✅     | zod on every route, event and job (`@cb/contracts`); body limit 100 KB by default.                          |
| 5.2.x | Untrusted HTML sanitised                     | ✅     | Problem statements are Markdown rendered by react-markdown without raw HTML; React escapes everything else. |
| 5.3.4 | No SQL injection                             | ✅     | drizzle query builder and parameterised `sql` templates only.                                               |
| 5.3.x | No user code runs on our servers or browsers | ✅     | Code is executed only by Judge0 (hosted); the editor never evaluates it.                                    |

## V7 Errors and logging

| #     | Requirement                              | Status | How / where                                                                                                                                                                                                                     |
| ----- | ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7.1.1 | No credentials or session tokens in logs | ✅     | pino `redact` (`packages/libs/logger`): passwords, hashes, tokens, `authorization`, cookies, `set-cookie`, the Judge0/RapidAPI key headers. The email log stores recipients only as a hash, and no email address goes on Kafka. |
| 7.4.1 | Generic errors with a reference          | ✅     | `{ error: { code, message, requestId } }`; stack traces never reach clients; same message for unknown user / bad password.                                                                                                      |

## V8 Data protection

| #     | Requirement                             | Status | How / where                                                                                     |
| ----- | --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| 8.2.1 | No sensitive data cached in the browser | ✅     | Auth responses are not cached; tokens only in HttpOnly cookies.                                 |
| 8.3.1 | Sensitive data not in URLs              | ✅     | Tokens travel in bodies/cookies (verify and reset links carry a single-use token, as intended). |
| 8.x   | Backups exist and restore               | ✅     | `infra/backup` nightly dumps + manifest; restore drill verified (Phase 6).                      |

## V9 Communications

| #     | Requirement                    | Status | How / where                                                                                     |
| ----- | ------------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| 9.1.1 | TLS for all client connections | ⚠️     | Caddy terminates TLS with automatic certificates **at deployment** (host choice after Phase 6). |
| 9.1.x | HSTS                           | ✅     | Gateway sends HSTS (helmet); Caddy adds it for the web origin at deployment.                    |

## V10 Malicious code and dependencies

| #      | Requirement                                     | Status | How / where                                                                                             |
| ------ | ----------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| 10.3.2 | Dependencies from trusted sources, kept current | ✅     | Exact versions, each ≥ 14 days old when added; `pnpm install --frozen-lockfile` and `check-deps` in CI. |
| 14.2.1 | Known vulnerabilities triaged                   | ✅     | `pnpm audit --prod` (below).                                                                            |

**Dependency audit (2026-11-12):** KaTeX upgraded to 0.19.1 (low: prototype-pollution bypass; it renders statements in the browser). Four moderate advisories remain, all in tooling paths that never see user input, accepted:

| Advisory                               | Path                                                        | Why it's not reachable                                          |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| esbuild ≤ 0.24.2 (dev server requests) | `@cb/testing` → drizzle-kit → @esbuild-kit                  | Test/migration tooling; no esbuild dev server runs anywhere.    |
| glob 9–14.0.1 (AbortSignal bypass)     | OTel auto-instrumentations → GCP resource detector → gaxios | The detector isn't enabled; nothing calls glob with user input. |
| minimatch 7–11.0.0 (ReDoS on patterns) | eslint; the same OTel path                                  | Lint time only / patterns are ours, not users'.                 |

## V12 Files and resources

| #      | Requirement        | Status | How / where                                                                                                      |
| ------ | ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------- |
| 12.1.1 | Upload size limits | ✅     | Problem test files: per-file and per-problem limits (`PROBLEM_LIMITS`), admin-only.                              |
| 12.x   | Avatar uploads     | —      | Not built yet; when it is: signed direct-to-Cloudinary, jpg/png/webp only, 2 MB, server accepts only our folder. |

## V13 API

| #      | Requirement                          | Status | How / where                                                                                       |
| ------ | ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| 13.1.x | Same authorisation on every API path | ✅     | Gateway is the only public entry; the web talks to it through its own same-origin proxy.          |
| 13.2.x | Rate limiting and idempotency        | ✅     | Per-IP limit at the gateway (300/min), per-route limits in identity; idempotency keys on creates. |

## V14 Configuration

| #      | Requirement                     | Status | How / where                                                                                                                                                                                                        |
| ------ | ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14.3.x | No debug features in production | ✅     | Env validation refuses `EMAIL_PROVIDER=fake` and `AUTH_RATE_LIMIT_SCALE≠1` in production; the fake inbox route only exists with the fake provider.                                                                 |
| 14.4.x | Security headers                | ✅     | Web: CSP (no third-party scripts, no eval, no framing, connections only to us), nosniff, X-Frame-Options DENY, COOP, Referrer-Policy, Permissions-Policy. Gateway: helmet. `e2e/csp.spec.ts` proves no violations. |
| 14.x   | Secrets out of the repo         | ⚠️     | `.env` files are gitignored. **Rotate the RapidAPI key before launch** (it appeared in a screenshot).                                                                                                              |

## Before launch

1. Breached-password check at register and reset (2.1.7).
2. TLS + HSTS through Caddy on the chosen host (9.1.1).
3. Rotate the RapidAPI key; generate fresh JWT keys and internal secrets for production (14.x).
4. Decide on the 12-character minimum for new passwords (2.1.1).
