---
title: Fast input and output
tags: implementation, io
---

## Why

With 10^5–10^6 numbers to read or print, slow input/output alone can exceed the time limit.

## C++

Add `ios::sync_with_stdio(false); cin.tie(nullptr);` at the start of `main`, and print `'\n'` instead of
`endl` (which flushes on every line).

## Java

Use `BufferedReader` with `StringTokenizer` (or a byte reader) instead of `Scanner`, and collect output
in a `StringBuilder` or `PrintWriter`, printing once at the end.

## Python

Read everything at once: `data = sys.stdin.buffer.read().split()`, then walk through it with an index.
Collect answers in a list and print `'\n'.join(map(str, answers))` once.

## JavaScript (Node)

Read the whole input with `require('fs').readFileSync(0, 'utf8')`, split it, and build one output
string.
