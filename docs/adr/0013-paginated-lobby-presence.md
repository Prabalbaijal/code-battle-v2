# ADR-0013: Lobby: live friends, paginated pull list for other online players

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

v1 broadcast every user's status to every user on each connect and disconnect: O(N²) traffic.

## Decision

Push presence changes only to friends. Other online players are a paginated, prefix-searchable list read from Redis ZSETs (by recency, plus a lexicographic set), refreshed every 15 s while the lobby is visible, with an online count.

## Consequences

Cost is O(page size) per viewer. The non-friend list is up to 15 s stale; the server re-checks on challenge.

## Alternatives considered

Global live broadcast (v1); live push of every online user.
