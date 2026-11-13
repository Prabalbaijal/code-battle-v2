---
title: Graphs, BFS and DFS
tags: graphs, bfs, dfs, trees
---

## Representation

Store an adjacency list (a list of neighbours per node): O(n + m) memory. An adjacency matrix is O(n^2)
and only fits small n.

## BFS

Explores level by level with a queue. In an unweighted graph it gives the shortest distance from the
start to every node. Mark a node visited when you push it, not when you pop it, or nodes get queued many
times.

## DFS

Goes deep first (recursion or an explicit stack). Uses: connected components, cycle detection,
topological order, subtree sizes and depths.

## Pitfalls

- Deep recursion can overflow the stack (Python's default limit is 1000; Java's stack is small too). Use
  an explicit stack or raise the limit carefully.
- Grids are graphs: the neighbours are the 4 (or 8) adjacent cells; check the bounds first.
- Weighted shortest paths need Dijkstra (non-negative weights), not BFS.
