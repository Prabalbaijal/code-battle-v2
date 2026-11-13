---
title: What each verdict means and how to debug it
tags: debugging, implementation
---

## Wrong Answer (WA)

The output differs from the expected one. Check overflow, off-by-one errors, edge cases (n = 1, all
equal values, negative numbers), the output format (one answer per line), and that you read all test
cases (`t` cases in one file).

## Time Limit Exceeded (TLE)

Too slow. Compare your complexity with the constraints (see the complexity note), then look for slow
input/output, an accidental O(n^2) (string concatenation in a loop, `pop(0)`), or an infinite loop.

## Runtime Error (RE)

The program crashed: an index out of bounds, division by zero, a null access, too-deep recursion, or an
uncaught exception (Java, Python). Note the failing case number and try similar inputs locally.

## Memory Limit Exceeded (MLE)

Too much memory: a huge 2D array, keeping every DP row when only the last one is needed, or unbounded
recursion.

## Compile Error (CE)

Read the compiler message. In Java the class must be called `Main`; in C++ include the headers you use.

## A habit that helps

Write a brute-force solution for tiny inputs and compare it with your fast one on random tests. It finds
most Wrong Answer bugs quickly.
