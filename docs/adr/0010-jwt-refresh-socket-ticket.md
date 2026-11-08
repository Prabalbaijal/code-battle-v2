# ADR-0010: Short-lived EdDSA JWT + rotating refresh tokens + socket tickets

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

v1 used a 1-day JWT with no revocation and looked up the DB on every socket connect. The web app (Vercel) and API (VM) are on different origins.

## Decision

15-minute EdDSA access tokens verified locally via JWKS; opaque refresh tokens rotated on every use with reuse detection; one-time 60 s tickets for WebSocket auth.

## Consequences

Stateless verification, real revocation, and cross-origin WebSockets without third-party cookies.

## Alternatives considered

Long-lived JWT in a cookie (v1); server sessions in Redis (makes Redis critical for auth).
