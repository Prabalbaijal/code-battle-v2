// Shared helpers for the k6 load tests (plan §20). k6 runs in Docker and reaches the dev stack on
// the host; traffic goes through the web app's /api proxy → gateway → services, like a browser.
import { check, fail, sleep } from 'k6';
import http from 'k6/http';

export const WEB = __ENV.WEB_URL || 'http://host.docker.internal:3000';
export const INBOX = __ENV.INBOX_URL || 'http://host.docker.internal:4003';
export const REALTIME = __ENV.REALTIME_URL || 'http://host.docker.internal:4010';
const ORIGIN = __ENV.ORIGIN || 'http://localhost:3000';
const PASSWORD = 'Load-test-pw-1';
const RUN = Math.random().toString(36).slice(2, 7);

/**
 * Every simulated player gets its own client address: the gateway trusts X-Forwarded-For from the
 * local Next proxy, so per-IP rate limits apply per player, as in production.
 */
export const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

export const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

const headers = (ip, extra = {}) => ({
  'content-type': 'application/json',
  origin: ORIGIN,
  'x-cb-csrf': '1',
  'x-forwarded-for': ip,
  ...extra,
});

export function api(method, path, body, { ip, tags = {}, jar } = {}) {
  const params = { headers: headers(ip, method === 'POST' ? { 'idempotency-key': uuid() } : {}), tags };
  if (jar) params.jar = jar;
  const url = `${WEB}/api/v1${path}`;
  return method === 'GET'
    ? http.get(url, params)
    : http.request(method, url, JSON.stringify(body ?? {}), params); // Fastify refuses an empty JSON body
}

/** Register and verify through the API and the dev fake inbox (setup only). */
export function createPlayers(count, tag) {
  const players = [];
  for (let i = 0; i < count; i++) {
    const username = `${tag}${RUN}${i}`;
    const email = `${username}@load.test`;
    const ip = ipFor(50_000 + players.length + Math.floor(Math.random() * 10_000));
    const reg = api(
      'POST',
      '/auth/register',
      { username, fullname: `Load ${i}`, email, password: PASSWORD },
      { ip },
    );
    if (reg.status !== 201) fail(`register ${username}: ${reg.status} ${reg.body}`);
    let token;
    for (let t = 0; t < 40 && !token; t++) {
      const r = http.get(`${INBOX}/internal/dev/inbox?to=${encodeURIComponent(email)}`);
      const m = (r.json('items') || []).map((x) => /verify-email\?token=([\w-]+)/.exec(x.text)).find(Boolean);
      token = m && m[1];
      if (!token) sleep(0.25);
    }
    if (!token) fail(`no verification mail for ${email}`);
    const v = api('POST', '/auth/verify-email', { token }, { ip });
    if (v.status >= 300) fail(`verify ${username}: ${v.status}`);
    players.push({ username, email });
  }
  return players;
}

/** Log in (cookies land in this VU's jar); returns the user's id. */
export function login(player, ip) {
  const r = api(
    'POST',
    '/auth/login',
    { identifier: player.username, password: PASSWORD },
    { ip, tags: { name: 'login' } },
  );
  check(r, { 'login 200': (x) => x.status === 200 });
  if (r.status !== 200) fail(`login ${player.username}: ${r.status} ${r.body}`);
  return r.json('user.id');
}
