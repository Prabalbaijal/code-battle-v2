---
title: Binary search (on arrays and on the answer)
tags: binary-search, sorting
---

## On a sorted array

Halve the search range at each step: O(log n). Use the library (`lower_bound`, `bisect_left`,
`Collections.binarySearch`) when you can.

## On the answer

If you can check "is answer x achievable?" quickly and the check is monotone (if x works, every bigger
x works too), binary search on x. Examples: the minimum time to finish all tasks, the largest minimum
distance when placing items.

## Getting the loop right

Keep an invariant: `lo` is always bad and `hi` is always good. Loop while `hi - lo > 1`, test
`mid = lo + (hi - lo) / 2`, and move `lo` or `hi` to `mid`. The answer is `hi`. This avoids infinite
loops and off-by-one mistakes.

## Pitfalls

- `(lo + hi) / 2` can overflow in 32-bit types; use `lo + (hi - lo) / 2`.
- With real numbers, loop a fixed number of times (e.g. 100) instead of comparing floats.
