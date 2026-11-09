#!/usr/bin/env node
// Generate an Ed25519 signing key for identity-service (plan §16).  Usage: pnpm gen-keys
// Prints a JWT_KEYS value. To rotate: put the new key FIRST and keep the old one until every token
// it signed has expired (access tokens live 15 min), then drop it.
import { generateKeyPairSync, randomUUID } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });
const kid = `k-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
const key = { ...jwk, kid, alg: 'EdDSA', use: 'sig' };

console.log(`JWT_KEYS='${JSON.stringify([key])}'`);
console.error('\nKeep this secret: add it to apps/identity-service/.env (never commit it).');
