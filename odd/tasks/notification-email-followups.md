# Notification email follow-ups

## Objective
Close the four non-blocking follow-ups recorded in PR #66 (notification email queue and worker).

## Problem
- A Resend `409 invalid_idempotent_request` (key reused with a different payload) is permanent, but the processor retries every 409 until attempts run out.
- The comment excerpt `.slice(0, COMMENT_EXCERPT_LENGTH)` can split a UTF-16 surrogate pair.
- `NotificationEmailProcessorDependencies.logger` declares `warn`, which the processor never calls.
- `composeEmail` has no exhaustiveness guard over `NotificationType`.

## Scope
`apps/api/src/notifications/{resend.service,notification-email.processor,notifications.constants}.ts` and their specs. Nothing else.

## Constraints
- Strict TDD: RED, then GREEN, then REFACTOR (runner: `pnpm vitest run` in `apps/api`).
- Resend error codes (source: https://resend.com/docs/dashboard/emails/idempotency-keys): `409 invalid_idempotent_request` is permanent; `409 concurrent_idempotent_requests` is retryable. The error body is JSON `{ statusCode, name, message }`.
- One Conventional Commit per task on `fix/api-notification-email-followups`.

## Tasks
- [x] T1 `ResendSendError` exposes the Resend error `name` (parsed best-effort from the JSON body); the processor treats `409 invalid_idempotent_request` as `UnrecoverableError` and keeps other 409s retryable.
  - RED: `expected undefined to be 'invalid_idempotent_request'` (resend.service.spec) and `expected ResendSendError ... to be an instance of UnrecoverableError` (notification-email.processor.spec). GREEN: 36/36 passing in both specs. Commit: pending (see below).
- [ ] T2 The comment excerpt never ends in a lone high surrogate.
- [ ] T3 Narrow the processor `logger` dependency to `debug` only.
- [ ] T4 Add a `never` exhaustiveness guard to `composeEmail`.

## Route
Delegated direct: one writer (the writer trigger fires because two or more non-trivial source files and their specs change).

## Acceptance / checks
`apps/api`: `pnpm vitest run`, `pnpm run -s typecheck`, `pnpm run -s lint` all clean.

## Progress
Branch created off main 4b07cd5. TDD: strict, source is the user's CLAUDE.md, runner is vitest.
