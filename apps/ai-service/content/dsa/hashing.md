---
title: Hash maps and sets
tags: hashing, implementation
---

## Idea

Hash maps (`unordered_map`, `HashMap`, `dict`, `Map`) give expected O(1) insert and lookup. They turn
"have I seen this before?" and "how many times?" from O(n) scans into O(1) checks.

## Patterns

- Two-sum: for each x, check whether `target - x` was already seen.
- Frequency counting: anagrams, the most common element, duplicates.
- Prefix sum + map: count subarrays with a given sum.

## Pitfalls

- Adversarial inputs can make C++ `unordered_map` slow (many collisions). A custom hash or a sorted
  `map` (O(log n)) avoids that.
- Iteration order of a hash map is not sorted.
- Keys must be immutable: in Python use tuples, not lists.
