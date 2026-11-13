---
title: Implementation habits for contests
tags: implementation, debugging
---

## Read the whole statement first

Note every constraint and the exact output format before coding. Many Wrong Answer verdicts come from a
misread line.

## Multiple test cases

When the input starts with `t`, reset every global array, counter and container between cases. A value
left over from the previous case is a classic hidden-test failure.

## Keep it simple

Prefer the simplest algorithm that fits the limits. Clear variable names and small helper functions
make bugs visible.

## Test before submitting

Run the samples, then a few edge cases you write yourself: minimum sizes, maximum values, all-equal
elements. In a battle every submission costs time, so one careful local check is cheaper than a Wrong
Answer.
