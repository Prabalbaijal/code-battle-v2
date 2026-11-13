---
title: Prefix sums
tags: prefix-sums, arrays, implementation
---

## Idea

Precompute `pre[i] = a[0] + … + a[i-1]` (with `pre[0] = 0`). Then the sum of any range `a[l..r]` is
`pre[r+1] - pre[l]`, in O(1). Building it costs O(n).

## When to use it

- Many range-sum queries on an array that doesn't change.
- "Count subarrays with sum k": combine prefix sums with a hash map of how often each prefix value
  appeared.
- 2D grids: `pre[i][j]` is the sum of the rectangle above and to the left; a rectangle query uses
  inclusion–exclusion.

## Pitfalls

- Off-by-one: decide once whether ranges are inclusive and whether arrays are 0- or 1-based.
- Overflow: prefix values grow up to n · max value; use 64-bit integers.
- If the array changes between queries, you need a Fenwick tree or a segment tree instead.

## Difference arrays

To add a value to many ranges and read the final array once, add v at `l` and subtract v at `r+1`, then
take prefix sums at the end: each range update becomes O(1).
