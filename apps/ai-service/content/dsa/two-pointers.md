---
title: Two pointers and sliding window
tags: two-pointers, arrays, sorting
---

## Idea

Keep two indices that only move forward. Each moves at most n times, so the whole scan is O(n) instead
of checking every pair in O(n^2).

## Typical patterns

- Sorted array, pair with sum x: one pointer at each end; move the left one up if the sum is too
  small, the right one down if it is too large.
- Sliding window: the longest or shortest subarray satisfying a condition. Grow the right end; while
  the window is invalid, shrink it from the left.
- Merging two sorted lists.

## When it works

The condition must be monotone: if a window is valid, every smaller window inside it is valid too (or
the reverse). Sums of non-negative numbers are monotone; sums with negative numbers are not (use prefix
sums with a hash map instead).
