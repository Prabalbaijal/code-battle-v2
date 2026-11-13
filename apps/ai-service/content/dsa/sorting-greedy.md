---
title: Sorting and greedy choices
tags: sorting, greedy
---

## Sorting first

Many problems become easy after sorting: duplicates sit next to each other, the closest pair is
adjacent, and two pointers or binary search become possible. Sorting costs O(n log n).

## Greedy

Make the locally best choice at each step and never undo it. It is correct only when you can argue that
some optimal solution makes the same choice (an "exchange argument").

Classic examples: pick intervals by earliest end time to fit the most; give each child the smallest
cookie that satisfies them; always merge the two smallest piles (with a priority queue).

## When greedy fails

If a small counterexample breaks your rule, you probably need dynamic programming. Try 3–4 tiny inputs
by hand before committing to a greedy rule.
