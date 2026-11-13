// Load test (plan §20): browsing, live sockets and real matches at the same time, through the web
// proxy → gateway → services, against fake-judge0. See load/README.md for how to run it.
//
//   PAIRS        players in matches = 2 × PAIRS (default 20)
//   SOCKETS      Socket.IO connections held open (default 200; ≤ 5 per player)
//   BROWSERS     virtual users browsing pages (default 40)
//   ROUNDS       matches per pair (default 3; each needs a problem both haven't seen)
//   DURATION     browsing time (default 2m)
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { api, createPlayers, ipFor, login, REALTIME, uuid } from './lib.js';

const PAIRS = Number(__ENV.PAIRS || 20);
const SOCKETS = Number(__ENV.SOCKETS || 200);
const BROWSERS = Number(__ENV.BROWSERS || 40);
const ROUNDS = Number(__ENV.ROUNDS || 3);
const DURATION = __ENV.DURATION || '2m';
const HOLD_MS = Number(__ENV.HOLD_MS || 240_000); // ≥ the matches window (20 s + 3 m)

const socketConnect = new Trend('socket_connect_ms', true);
const socketOk = new Rate('socket_connected');
const matchStart = new Trend('match_start_ms', true);
const judgeVerdict = new Trend('judge_verdict_ms', true);
const matchesPlayed = new Counter('matches_completed');
const matchFailed = new Counter('matches_failed');

export const options = {
  setupTimeout: '10m',
  noCookiesReset: true, // each VU stays logged in across iterations (k6 clears the jar by default)
  scenarios: {
    online: {
      executor: 'per-vu-iterations',
      exec: 'online',
      vus: SOCKETS,
      iterations: 1,
      maxDuration: `${Math.ceil(HOLD_MS / 1000) + 60}s`,
    },
    browse: {
      executor: 'constant-vus',
      exec: 'browse',
      vus: BROWSERS,
      duration: DURATION,
      startTime: '15s',
    },
    matches: {
      executor: 'per-vu-iterations',
      exec: 'matches',
      vus: PAIRS * 2,
      iterations: ROUNDS,
      startTime: '20s', // after the sockets are up: challenges go to online players only
      maxDuration: '3m',
    },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<200'], // API SLO (plan §19)
    match_start_ms: ['p(95)<1500'], // match start SLO
    judge_verdict_ms: ['p(95)<6000'], // judge stage-1 SLO
    socket_connected: ['rate>0.99'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const players = createPlayers(PAIRS * 2, 'ld');
  return { players };
}

// ---- per-VU session (k6 keeps module state per VU) ----
let me;
/** This VU's player: index `slot` (defaults to one spread by VU id), logged in once. */
function session(data, slot = exec.vu.idInTest - 1) {
  if (!me) {
    const player = data.players[slot % data.players.length];
    const ip = ipFor(exec.vu.idInTest);
    me = { ...player, slot: slot % data.players.length, ip, id: login(player, ip) };
  }
  return me;
}

/** Hold one Socket.IO connection (engine.io v4 over a raw WebSocket) for HOLD_MS. */
export function online(data) {
  const s = session(data);
  const t = api('POST', '/auth/socket-ticket', null, { ip: s.ip, tags: { name: 'socket-ticket' } });
  if (!check(t, { 'ticket 200': (r) => r.status === 200 })) return socketOk.add(false);
  const url = `${REALTIME.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  const t0 = Date.now();
  let connected = false;
  ws.connect(url, { headers: { Origin: 'http://localhost:3000' } }, (socket) => {
    socket.on('message', (m) => {
      if (m.startsWith('0{')) socket.send(`40${JSON.stringify({ ticket: t.json('ticket') })}`);
      else if (m.startsWith('40')) {
        connected = true;
        socketConnect.add(Date.now() - t0);
      } else if (m === '2')
        socket.send('3'); // engine.io heartbeat
      else if (m.startsWith('44')) socket.close();
    });
    socket.setInterval(() => socket.send('42["presence:ping"]'), 25_000);
    socket.setTimeout(() => socket.close(), HOLD_MS);
  });
  socketOk.add(connected);
}

/** Pages a signed-in player looks at, as the web app calls them. */
export function browse(data) {
  const s = session(data);
  const get = (path, name) => {
    const r = api('GET', path, null, { ip: s.ip, tags: { name } });
    check(r, { [`${name} 200`]: (x) => x.status === 200 });
  };
  get('/leaderboard', 'leaderboard');
  get('/leaderboard/me', 'leaderboard-me');
  get(`/bff/profile/${s.username}`, 'profile');
  get('/presence/online?limit=20', 'lobby-online');
  get('/presence/online/count', 'lobby-count');
  get('/notifications/unread-count', 'unread');
  get('/matches/active', 'active-match');
  sleep(1);
}

// 1 s, like the web app's fallback resync (in the browser these updates arrive over the socket)
const wait = (fn, timeoutMs, stepMs = 1000) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    sleep(stepMs / 1000);
  }
  return null;
};

/** One match per iteration: odd VUs challenge, even VUs accept; A submits, B forfeits if needed. */
export function matches(data) {
  // Each VU plays one player, pairs 0↔1, 2↔3, … k6 doesn't give a scenario contiguous VU ids, so
  // the slot comes from the VU's first iteration number: every VU starts its first iteration at
  // the same moment (and each takes seconds), so those numbers are 0 … 2·PAIRS−1, once each.
  const s = session(data, exec.scenario.iterationInTest);
  const i = s.slot;
  const challenger = i % 2 === 0;
  const partner = data.players[challenger ? i + 1 : i - 1];
  const opts = { ip: s.ip };

  if (challenger) {
    const target = api('GET', `/users/${partner.username}`, null, { ...opts, tags: { name: 'user' } }).json(
      'id',
    );
    // the partner may still be finishing the previous round: retry until they're free
    let last;
    const ch = wait(
      () => {
        const r = api('POST', '/challenges', { toUserId: target }, { ...opts, tags: { name: 'challenge' } });
        last = r;
        return r.status === 201 ? r : null;
      },
      30_000,
      1000,
    );
    if (!ch) {
      console.warn(`challenge ${last?.status}: ${last?.body}`);
      return void matchFailed.add(1, { step: 'challenge' });
    }
    // the match exists as soon as the accept commits, but has a problem only once it's started
    const state = wait(() => {
      const r = api('GET', '/matches/active', null, { ...opts, tags: { name: 'active-match' } });
      const id = r.json('match.matchId');
      if (!id) return null;
      const st = api('GET', `/matches/${id}/state`, null, { ...opts, tags: { name: 'match-state' } });
      return st.json('status') === 'in_progress' ? st : null;
    }, 30_000);
    if (!state) {
      console.warn('the match never started (30 s)');
      return void matchFailed.add(1, { step: 'start' });
    }
    const matchId = state.json('matchId');
    const t0 = Date.now();
    const sub = api(
      'POST',
      '/submissions',
      {
        mode: 'submit',
        problemId: state.json('problemId'),
        matchId,
        languageKey: 'python',
        code: `# @fake program=sum-cases\n# ${uuid()}\nprint("y")\n`,
      },
      { ...opts, tags: { name: 'submit' } },
    );
    if (!check(sub, { 'submit 202': (r) => r.status === 202 })) {
      console.warn(`submit ${sub.status}: ${sub.body}`);
      return void matchFailed.add(1, { step: 'submit' });
    }
    const done = wait(() => {
      const r = api('GET', `/submissions/${sub.json('submissionId')}`, null, {
        ...opts,
        tags: { name: 'submission' },
      });
      return r.json('status') === 'done' ? r : null;
    }, 60_000);
    if (!done) return void matchFailed.add(1, { step: 'verdict' });
    judgeVerdict.add(Date.now() - t0);
    const over = wait(() => {
      const r = api('GET', `/matches/${matchId}/state`, null, { ...opts, tags: { name: 'match-state' } });
      return r.json('status') === 'completed' || r.json('status') === 'aborted' ? r : null;
    }, 60_000);
    if (over) matchesPlayed.add(1);
    else matchFailed.add(1, { step: 'finish' });
    sleep(6); // the judge allows one submission per player every 5 s
    return;
  }

  // the accepter
  const incoming = wait(() => {
    const r = api('GET', '/challenges?direction=incoming', null, { ...opts, tags: { name: 'incoming' } });
    const items = r.json('items') || [];
    return items.length ? items[0] : null;
  }, 45_000);
  if (!incoming) {
    console.warn('no incoming challenge (45 s)');
    return void matchFailed.add(1, { step: 'incoming' });
  }
  const acc = api('POST', `/challenges/${incoming.id}/accept`, null, { ...opts, tags: { name: 'accept' } });
  if (
    !check(acc, { 'accept → in progress': (r) => r.status === 200 && r.json('status') === 'in_progress' })
  ) {
    console.warn(`accept ${acc.status}: ${acc.body}`);
    return void matchFailed.add(1, { step: 'accept' });
  }
  matchStart.add(acc.timings.duration); // the whole start saga: lock both, pick a problem, start
  const matchId = acc.json('matchId');
  // an Accepted verdict ends the match within a few seconds; otherwise (WA on this problem) forfeit
  const over = wait(
    () => {
      const r = api('GET', `/matches/${matchId}/state`, null, { ...opts, tags: { name: 'match-state' } });
      return ['completed', 'aborted'].includes(r.json('status')) ? true : null;
    },
    20_000,
    1000,
  );
  if (!over) api('POST', `/matches/${matchId}/forfeit`, null, { ...opts, tags: { name: 'forfeit' } });
  wait(() => {
    const r = api('GET', '/matches/active', null, { ...opts, tags: { name: 'active-match' } });
    return r.status === 200 && !r.json('match') ? true : null;
  }, 30_000);
}

export function handleSummary(data) {
  const m = (name, stat = 'p(95)') => {
    const v = data.metrics[name]?.values?.[stat];
    return v === undefined ? '—' : `${Math.round(v)}`;
  };
  const lines = [
    `browse p95 ${m('http_req_duration{scenario:browse}')} ms, p99 ${m('http_req_duration{scenario:browse}', 'p(99)')} ms, requests ${m('http_reqs', 'count')}`,
    `socket connect p95 ${m('socket_connect_ms')} ms, connected ${((data.metrics.socket_connected?.values?.rate ?? 0) * 100).toFixed(1)}%`,
    `match start p95 ${m('match_start_ms')} ms, judge verdict p95 ${m('judge_verdict_ms')} ms`,
    `matches completed ${m('matches_completed', 'count')}, failed ${m('matches_failed', 'count')}`,
  ];
  return {
    stdout: `\n${lines.join('\n')}\n`,
    '/scripts/results/summary.json': JSON.stringify(data, null, 2),
  };
}

export { fail };
