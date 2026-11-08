# ADR-0008: Hosted Judge0 API behind a CodeExecutor interface

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

The owner will not self-host a compiler or sandbox, and the budget is about ₹0. Hosted Judge0 charges per submission and caps limits.

## Decision

Use the hosted Judge0 API through a `CodeExecutor` interface. Each problem has 3–4 packed test files (samples, small, large) judged in two batched stages that fail fast. Callbacks with a polling fallback, a verdict cache, a daily budget with admission control, and calibration from reference solutions. `apps/fake-judge0` is used in dev, CI and load tests.

## Consequences

About 3 Judge0 calls per submission instead of one per test; quota-aware gameplay. Self-hosting later is an adapter swap.

## Alternatives considered

Self-hosted Judge0 or isolate (more control, but needs a privileged x86 VM).
