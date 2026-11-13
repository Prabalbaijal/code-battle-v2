---
title: Integer overflow and choosing types
tags: math, implementation, overflow
---

## The symptom

Your logic is right and the samples pass, but you get Wrong Answer on a hidden case with large values.
That is very often overflow.

## Limits to remember

- 32-bit `int`: about ±2.1 · 10^9.
- 64-bit `long long` (C++) / `long` (Java): about ±9.2 · 10^18.
- Python integers never overflow; JavaScript numbers are exact only up to 2^53 ≈ 9 · 10^15.

## Where overflow hides

- Sums of many values: n · max value, e.g. 2·10^5 values of 10^9 is 2·10^14.
- Products: `a * b` where both fit in an int but the product doesn't. Write `1LL * a * b` in C++.
- Squares and distances: `x * x` with x up to 10^5 already needs 64 bits.
- Intermediate values in modular arithmetic: take `% MOD` after every multiplication.

## Fix

Read the constraints, compute the largest possible intermediate value, and pick the type before you
write the loop. In JavaScript, use `BigInt` when values can pass 2^53.
