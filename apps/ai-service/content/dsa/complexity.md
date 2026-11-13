---
title: Time complexity and the 10^8 rule
tags: complexity, implementation, math
---

## Why it matters

A judge gives your program a time limit (usually 1–3 seconds). Before writing code, estimate how many
basic operations your idea needs for the largest input in the constraints.

## The 10^8 rule of thumb

A compiled language (C++) does roughly 10^8 simple operations per second; Java about the same after
warm-up; Python is 10–50× slower. So for n up to:

- 10–12: O(n!) or O(2^n · n) can pass;
- 20–25: O(2^n);
- 500: O(n^3);
- 5,000: O(n^2);
- 10^5–10^6: O(n log n) or O(n);
- 10^9 and more: O(log n) or O(1) (math, binary search).

## Reading constraints

Constraints tell you the intended complexity. "n ≤ 2·10^5" almost always means O(n log n) or better.
If your idea is O(n^2) there, it will get Time Limit Exceeded (TLE), however tidy the code is.

## Hidden costs

- Copying a string or vector inside a loop multiplies the cost.
- `list.pop(0)` in Python and erasing at the front of a vector are O(n) each.
- Recursion without memoisation can be exponential.
- Slow input/output can dominate for 10^5+ lines: see the fast I/O note.
