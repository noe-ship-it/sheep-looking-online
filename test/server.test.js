import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { createServer } from '../server/index.js';
import { config } from '../server/rooms.js';
import { isValidSheep, isHalf } from '../shared/cards.js';

let srv; let url;
before(async () => {
  config.publicAutoStartMs = 300;
  srv = createServer();
  await new Promise((r) => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});
after(async () => { for (const r of [...srv.manager.rooms.values()]) srv.manager.destroy(r); srv.io.close(); await new Promise((r) => srv.server.close(r)); clearInterval(srv.manager.sweeper); });

function client() {
  const s = ioc(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.last = null;
  s.on('state', (m) => { s.last = m; s.emit('_tick'); });
  s.call = (ev, p = {}) => new Promise((res) => s.emit(ev, p, res));
  s.ready = new Promise((r) => s.on('connect', r));
  return s;
}
const until = async (pred, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await new Promise((r) => setTimeout(r, 10)); }
};

/** Very simple bot: respond to whatever the game is waiting on this client for. */
async function botStep(s) {
  const g = s.last?.game; if (!g || g.phase !== 'playing' || g.waitingOn !== s.last.you) return false;
  const me = g.players.find((p) => p.id === s.last.you);
  const pd = g.pending;
  const act = (action) => s.call('game:action', { action });
  if (pd) {
    if (pd.stage === 'guess') return act({ type: 'guess', looking: Math.random() < 0.5 });
    if (pd.stage === 'reflip') { const rf = me.hand.find((c) => c.kind === 'reflip'); return act(rf && Math.random() < 0.5 ? { type: 'reflip', cardId: rf.id } : { type: 'acceptFlip' }); }
    const loser = g.players.find((p) => p.id === pd.loserId);
    const n = pd.options.pick ?? 0;
    if (pd.effect === 'halve2') return act({ type: 'effectChoice', halves: loser.field.slice(0, n).map((sh) => ({ sheepId: sh.id, cardId: sh.cards[1].id })) });
    if (pd.effect === 'recover1') {
      const hs = g.discard.filter(isHalf);
      for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) if (isValidSheep(hs[i], hs[j])) return act({ type: 'effectChoice', recover: { cardIds: [hs[i].id, hs[j].id] } });
      return act({ type: 'effectChoice', recover: null });
    }
    return act({ type: 'effectChoice', sheepIds: loser.field.slice(0, n).map((sh) => sh.id) });
  }
  // Make a sheep if possible.
  const hs = me.hand.filter(isHalf);
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) if (isValidSheep(hs[i], hs[j])) return act({ type: 'makeSheep', cardIds: [hs[i].id, hs[j].id] });
  // Play an ITSLAM card sometimes (so they get exercised).
  const it = me.hand.find((c) => c.kind === 'itslam');
  const opp = g.players.find((p) => p.id !== me.id && !p.left);
  if (it && !g.itslamPlayedThisTurn) return act({ type: 'itslam', cardId: it.id, targetId: opp.id });
  const wolf = me.hand.find((c) => c.kind === 'wolf');
  const victim = g.players.find((p) => p.id !== me.id && !p.left && p.field.length && !p.wolfProtected);
  if (wolf && victim) return act({ type: 'wolf', cardId: wolf.id, targetId: victim.id, sheepId: victim.field[0].id });
  const need = Math.max(0, me.hand.length - 7);
  return act({ type: 'endTurn', discardIds: me.hand.filter((c) => c.kind !== 'itslam').slice(0, need).map((c) => c.id) });
}

async function playOut(clients, maxSteps = 3000) {
  for (let i = 0; i < maxSteps; i++) {
    if (clients.every((c) => c.last?.game?.phase === 'ended')) return;
    let moved = false;
    for (const c of clients) {
      const before = JSON.stringify(c.last?.game?.log.at(-1));
      const res = await botStep(c);
      if (res) {
        assert.ok(!res.error, `bot action rejected: ${res.error}`);
        moved = true;
        await until(() => JSON.stringify(c.last?.game?.log.at(-1)) !== before || c.last.game.phase === 'ended').catch(() => {});
      }
    }
    if (!moved) await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('game did not finish');
}

test('private room: create, join by code, 3-player full game, hidden hands, rematch', async () => {
  const [a, b, c] = [client(), client(), client()];
  await Promise.all([a.ready, b.ready, c.ready]);
  const ra = await a.call('room:create', { name: 'Alice', isPublic: false });
  assert.ok(ra.ok && /^[A-Z2-9]{5}$/.test(ra.code));
  assert.equal((await b.call('room:join', { code: ra.code.toLowerCase(), name: 'Bob' })).ok, true);
  assert.equal((await c.call('room:join', { code: ra.code, name: 'alice' })).ok, true); // duplicate name gets suffixed
  await until(() => a.last?.room.members.length === 3);
  assert.equal(a.last.room.members[2].name, 'alice 2');
  assert.match((await b.call('room:start')).error, /host/);
  assert.ok((await a.call('room:start')).ok);
  await until(() => [a, b, c].every((s) => s.last?.game));
  // Non-turn player can't act; hands are hidden.
  const g = a.last.game;
  const notTurn = [a, b, c].find((s) => s.last.you !== g.turnPlayerId);
  assert.match((await notTurn.call('game:action', { action: { type: 'endTurn', discardIds: [] } })).error, /not your turn/);
  for (const s of [a, b, c]) for (const p of s.last.game.players) assert.equal(p.hand !== undefined, p.id === s.last.you);
  await playOut([a, b, c]);
  const res = a.last.game.result;
  assert.equal(res.scores.length, 3);
  assert.ok(res.winners.length >= 1);
  assert.equal(a.last.room.status, 'ended');
  assert.ok((await a.call('room:rematch')).ok);
  await until(() => b.last.game?.phase === 'playing');
  [a, b, c].forEach((s) => s.close());
});

test('turn timer: 18 s by default, shown to clients, and an idle turn ends automatically', async () => {
  assert.equal(config.turnMs, 18000);
  const [a, b] = [client(), client()];
  await Promise.all([a.ready, b.ready]);
  const ra = await a.call('room:create', { name: 'A' });
  await b.call('room:join', { code: ra.code, name: 'B' });
  await a.call('room:start');
  await until(() => a.last?.game && b.last?.game);
  const left = a.last.room.deadline - a.last.room.serverNow; // what the client's countdown starts from
  assert.ok(left > 17500 && left <= 18000, `deadline ${left}ms`);
  // Timeout behaviour (the existing rule, with the timeout shortened for the test): the idle player's turn ends and play moves on.
  const first = a.last.game.turnPlayerId;
  const room = srv.manager.get(ra.code);
  const old = config.turnMs; config.turnMs = 300;
  room.deadlineKey = null; srv.manager.armTimer(room);
  await until(() => a.last.game.turnPlayerId !== first, 3000);
  assert.ok(a.last.game.log.some((e) => /said "Baa!"/.test(e.text)));
  // The next turn gets a fresh deadline from the (restored) 18 s setting, which the client counts down from.
  config.turnMs = old;
  a.close(); b.close();
  srv.manager.destroy(srv.manager.get(ra.code)); // don't count towards the per-network open-room limit

});

test('room capacity is 4', async () => {
  const cs = Array.from({ length: 5 }, client);
  await Promise.all(cs.map((s) => s.ready));
  const r = await cs[0].call('room:create', { name: 'H' });
  for (let i = 1; i < 4; i++) assert.ok((await cs[i].call('room:join', { code: r.code, name: `P${i}` })).ok);
  assert.match((await cs[4].call('room:join', { code: r.code, name: 'Late' })).error, /full/);
  assert.match((await cs[4].call('room:join', { code: 'ZZZZZ', name: 'X' })).error, /No room/);
  cs.forEach((s) => s.close());
});

test('quick match pairs strangers and auto-starts a public game', async () => {
  const [a, b] = [client(), client()];
  await Promise.all([a.ready, b.ready]);
  const ra = await a.call('match:quick', { name: 'Ann' });
  const rb = await b.call('match:quick', { name: 'Ben' });
  assert.equal(ra.code, rb.code);
  try { await until(() => a.last?.game?.phase === 'playing' && b.last?.game?.phase === 'playing', 3000); } finally { a.close(); b.close(); }
});

test('disconnect + resume restores the seat and private hand; bad secret rejected', async () => {
  const [a, b] = [client(), client()];
  await Promise.all([a.ready, b.ready]);
  const ra = await a.call('room:create', { name: 'A' });
  const rb = await b.call('room:join', { code: ra.code, name: 'B' });
  await a.call('room:start');
  await until(() => b.last?.game);
  const handBefore = b.last.game.players.find((p) => p.id === rb.playerId).hand.map((c) => c.id).sort();
  b.close();
  await until(() => a.last.room.members.find((m) => m.id === rb.playerId).connected === false);
  const thief = client(); await thief.ready;
  assert.match((await thief.call('room:resume', { code: ra.code, playerId: rb.playerId, secret: 'x'.repeat(rb.secret.length) })).error, /no longer available/);
  const b2 = client(); await b2.ready;
  assert.ok((await b2.call('room:resume', { code: rb.code, playerId: rb.playerId, secret: rb.secret })).ok);
  await until(() => b2.last?.game);
  const me = b2.last.game.players.find((p) => p.id === rb.playerId);
  // Hand may have grown by a draw if it became B's turn meanwhile; original cards still there.
  for (const id of handBefore) assert.ok(me.hand.some((c) => c.id === id));
  await until(() => a.last.room.members.every((m) => m.connected));
  [a, b2, thief].forEach((s) => s.close());
});

test('disconnected player\'s turn is auto-played after the grace period', async () => {
  const old = config.disconnectedTurnMs; config.disconnectedTurnMs = 200;
  const [a, b] = [client(), client()];
  await Promise.all([a.ready, b.ready]);
  const ra = await a.call('room:create', { name: 'A' });
  await b.call('room:join', { code: ra.code, name: 'B' });
  await a.call('room:start');
  await until(() => a.last?.game && b.last?.game);
  // Make sure it's B's turn, then drop B.
  if (a.last.game.turnPlayerId === ra.playerId) await a.call('game:action', { action: { type: 'endTurn', discardIds: a.last.game.players.find((p) => p.id === ra.playerId).hand.filter((c) => c.kind !== 'itslam').slice(0, Math.max(0, a.last.game.players.find((p) => p.id === ra.playerId).hand.length - 7)).map((c) => c.id) } });
  await until(() => a.last.game.turnPlayerId !== ra.playerId);
  b.close();
  await until(() => a.last.game.turnPlayerId === ra.playerId, 3000);
  config.disconnectedTurnMs = old;
  a.close();
});

test('input safeguards: names sanitised, junk payloads rejected, rate limited', async () => {
  const a = client(); await a.ready;
  const r = await a.call('room:create', { name: '<script>alert(1)</script>‮' + 'x'.repeat(40) });
  assert.ok(r.ok);
  await until(() => a.last);
  const name = a.last.room.members[0].name;
  assert.ok(!/[<>]/.test(name) && name.length <= 16);
  assert.match((await a.call('game:action', { action: 'nope' })).error, /not in progress|Bad/);
  assert.match((await a.call('room:join', { code: '../../', name: 'x' })).error, /5 letters/);
  const results = await Promise.all(Array.from({ length: 60 }, () => a.call('room:start')));
  assert.ok(results.some((x) => x.error === 'Slow down a little!'));
  a.close();
});

test('serves the client, room links and health check', async () => {
  const home = await fetch(url + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await (await fetch(url + '/r/ABCDE')).text(), /Is That Sheep Looking At Me/);
  assert.equal((await fetch(url + '/shared/cards.js')).status, 200);
  assert.equal((await fetch(url + '/app.js')).status, 200);
  for (const f of ['/', '/app.js', '/style.css', '/shared/cards.js', '/r/ABCDE']) assert.equal((await fetch(url + f)).headers.get('cache-control'), 'no-cache', f);
  assert.match((await fetch(url + '/cards/wolf.webp')).headers.get('cache-control'), /max-age=86400/);
  assert.equal((await (await fetch(url + '/healthz')).json()).ok, true);
});
