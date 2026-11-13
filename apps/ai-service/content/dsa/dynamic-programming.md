---
title: Dynamic programming basics
tags: dynamic-programming, dp
---

## Idea

Break the problem into overlapping subproblems, solve each once, and store the answers. It works when
the best answer for a bigger input is built from the best answers for smaller ones.

## Steps

1. State: what does `dp[i]` (or `dp[i][j]`) mean, in words?
2. Transition: how is `dp[i]` computed from smaller states?
3. Base cases.
4. Order: compute states before they are needed (or memoise a recursion).
5. Answer: which state holds it?

## Classics

Fibonacci-style counting, coin change, longest increasing subsequence, knapsack, edit distance, counting
paths in a grid.

## Complexity

Number of states × work per transition. 10^5 states with O(1) transitions is fine; 10^4 × 10^4 states
(10^8) is borderline and needs care with memory (keep only the previous row).

## Pitfalls

Counting problems usually ask for the answer modulo 10^9+7: take the modulo at every step.
