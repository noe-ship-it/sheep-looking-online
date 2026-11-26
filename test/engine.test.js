import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, autoAct, viewFor, scoreOf, playerLeaves, RuleError, currentPlayer, HAND_MAX, waitingOn,
} from '../server/engine.js';
import { buildDeck, isValidSheep } from '../shared/cards.js';

let uid = 0;
const C = (kind, color, extra = {}) => ({ id: `t${++uid}`, kind, ...(color ? { color } : {}), ...extra });
const H = (color) => C('head', color);
const B = (color) => C('butt', color);
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

/** 2-4 player game with empty hands, Alice to play, a big deck. */
function setup(n = 2) {
  const names = ['Alice', 'Bob', 'Cara', 'Dan'].slice(0, n);
  const g = createGame(names.map((name, i) => ({ id: `p${i}`, name })), seq(0));
  g.players.forEach((p) => { p.hand = []; p.field = []; });
  g.turn = 0;
  g.deck = Array.from({ length: 20 }, () => H('grey'));
  g.discard = [];
  g.deckEmptied = false;
  return g;
}
const sheep = (g, a, b, m = null) => ({ id: `s${g.nextSheepId++}`, cards: [a, b], modifier: m });
const throws = (fn, re) => assert.throws(fn, (e) => e instanceof RuleError && (!re || re.test(e.message)));

test('deck has the 54 cards of the official Print & Play', () => {
  const d = buildDeck();
  assert.equal(d.length, 54);
  const count = (k) => d.filter((c) => c.kind === k).length;
  assert.equal(count('head'), 18); assert.equal(count('butt'), 18);
  assert.equal(d.filter((c) => c.color === 'rainbow').length, 4);
  assert.ok(d.every((c) => c.art));
  assert.deepEqual([count('paint'), count('franken'), count('wheat'), count('wolf'), count('yoink'), count('reflip'), count('itslam')], [2, 2, 3, 2, 2, 2, 5]);
  assert.equal(new Set(d.map((c) => c.id)).size, 54);
});

test('setup deals 5 each, then first player draws 1', () => {
  const g = createGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], Math.random);
  const first = currentPlayer(g);
  for (const p of g.players) assert.equal(p.hand.length, p === first ? 6 : 5);
  assert.equal(g.deck.length, 54 - 15 - 1);
});

test('rejects 1 or 5 players', () => {
  throws(() => createGame([{ id: 'a', name: 'A' }]));
  throws(() => createGame('abcde'.split('').map((id) => ({ id, name: id }))));
});

test('sheep validity: matching, rainbow, paint, franken', () => {
  assert.ok(isValidSheep(H('cyan'), B('cyan')));
  assert.ok(!isValidSheep(H('cyan'), B('red')));
  assert.ok(isValidSheep(H('rainbow'), B('red')));
  assert.ok(isValidSheep(H('magenta'), B('rainbow')));
  assert.ok(!isValidSheep(H('cyan'), H('cyan')));
  assert.ok(isValidSheep(H('orange'), B('green'), C('paint')));
  assert.ok(!isValidSheep(H('orange'), H('green'), C('paint')));
  assert.ok(isValidSheep(H('red'), H('yellow'), C('franken')));
  assert.ok(isValidSheep(B('red'), B('yellow'), C('franken')));
  assert.ok(!isValidSheep(H('red'), B('yellow'), C('franken')));
});

test('make sheep from hand; invalid combos rejected; not on others\' turn', () => {
  const g = setup();
  const [a, b, c] = [H('cyan'), B('cyan'), B('red')];
  g.players[0].hand = [a, b, c];
  throws(() => applyAction(g, 'p0', { type: 'makeSheep', cardIds: [a.id, c.id] }), /Colours/);
  throws(() => applyAction(g, 'p1', { type: 'makeSheep', cardIds: [a.id, b.id] }), /not your turn/);
  applyAction(g, 'p0', { type: 'makeSheep', cardIds: [a.id, b.id] });
  assert.equal(g.players[0].field.length, 1);
  assert.deepEqual(g.players[0].hand, [c]);
});

test('full rainbow sheep scores 2, normal sheep 1, ITSLAM in hand -3', () => {
  const g = setup();
  const p = g.players[0];
  p.field = [sheep(g, H('rainbow'), B('rainbow')), sheep(g, H('red'), H('blue'), C('franken')), sheep(g, H('red'), B('rainbow'))];
  p.hand = [C('itslam', null, { effect: 'lure2' })];
  assert.deepEqual(scoreOf(p).total, 2 + 1 + 1 - 3);
});

test('bodyswap own sheep upgrades to rainbow and returns replaced half', () => {
  const g = setup();
  const p = g.players[0];
  const mint = B('mint'); const rb = B('rainbow');
  const s = sheep(g, H('rainbow'), mint); p.field = [s]; p.hand = [rb];
  applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p0', sheepId: s.id, replaceCardId: mint.id, handCardId: rb.id });
  assert.equal(scoreOf(p).sheep, 2);
  assert.deepEqual(p.hand, [mint]);
});

test('bodyswap opponent painted sheep: sheep stays, swapper takes half + modifier', () => {
  const g = setup();
  const paint = C('paint'); const green = B('green'); const orangeButt = B('orange');
  const s = sheep(g, H('orange'), green, paint);
  g.players[1].field = [s]; g.players[0].hand = [orangeButt];
  applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: s.id, replaceCardId: green.id, handCardId: orangeButt.id });
  assert.equal(g.players[1].field.length, 1);
  assert.equal(s.modifier, null);
  assert.deepEqual(new Set(g.players[0].hand), new Set([green, paint]));
});

test('bodyswap frankensheep with matching butt; must leave a matching sheep', () => {
  const g = setup();
  const fr = C('franken'); const red = H('red'); const yellow = H('yellow');
  const s = sheep(g, red, yellow, fr);
  g.players[1].field = [s];
  const blueButt = B('blue'); const redButt = B('red');
  g.players[0].hand = [blueButt, redButt];
  throws(() => applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: s.id, replaceCardId: yellow.id, handCardId: blueButt.id }), /Basic Sheep or a Full Rainbow/);
  applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: s.id, replaceCardId: yellow.id, handCardId: redButt.id });
  assert.deepEqual(s.cards.map((c) => c.id), [red.id, redButt.id]);
  assert.ok(g.players[0].hand.includes(yellow) && g.players[0].hand.includes(fr));
});

test('yoink steals 2 random cards', () => {
  const g = setup();
  const y = C('yoink');
  g.players[0].hand = [y]; g.players[1].hand = [H('red'), B('red'), C('wolf')];
  applyAction(g, 'p0', { type: 'yoink', cardId: y.id, targetId: 'p1' }, seq(0));
  assert.equal(g.players[0].hand.length, 2);
  assert.equal(g.players[1].hand.length, 1);
  assert.ok(g.discard.includes(y));
});

test('wheat lures a sheep, blocked by double-butt frankensheep', () => {
  const g = setup();
  const w1 = C('wheat'); const w2 = C('wheat');
  const target = sheep(g, H('red'), B('red'));
  g.players[1].field = [target];
  g.players[0].hand = [w1, w2];
  applyAction(g, 'p0', { type: 'wheat', cardId: w1.id, targetId: 'p1', sheepId: target.id });
  assert.deepEqual(g.players[0].field, [target]);
  const t2 = sheep(g, H('cyan'), B('cyan'));
  g.players[1].field = [t2, sheep(g, B('a'), B('b'), C('franken'))];
  throws(() => applyAction(g, 'p0', { type: 'wheat', cardId: w2.id, targetId: 'p1', sheepId: t2.id }), /no mouth/);
  // Wheat may target any field (player's choice), including your own.
  applyAction(g, 'p0', { type: 'wheat', cardId: w2.id, targetId: 'p0', sheepId: target.id });
  assert.equal(g.players[0].field.length, 1);
});

test('wolf discards a sheep (all its cards), blocked by double-head frankensheep', () => {
  const g = setup();
  const wolf = C('wolf'); const wolf2 = C('wolf');
  const t = sheep(g, H('red'), B('blue'), C('paint'));
  g.players[1].field = [t]; g.players[0].hand = [wolf, wolf2];
  applyAction(g, 'p0', { type: 'wolf', cardId: wolf.id, targetId: 'p1', sheepId: t.id });
  assert.equal(g.players[1].field.length, 0);
  assert.equal(g.discard.length, 4);
  const t2 = sheep(g, H('cyan'), B('cyan'));
  g.players[1].field = [t2, sheep(g, H('a'), H('b'), C('franken'))];
  throws(() => applyAction(g, 'p0', { type: 'wolf', cardId: wolf2.id, targetId: 'p1', sheepId: t2.id }), /sees the wolf/);
});

function itslamGame(effect) {
  const g = setup();
  const card = C('itslam', null, { effect });
  g.players[0].hand = [card];
  return { g, card };
}

test('ITSLAM correct guess: attacker lures 2 sheep, ignoring franken protection', () => {
  const { g, card } = itslamGame('lure2');
  const s1 = sheep(g, H('red'), B('red')); const s2 = sheep(g, B('x'), B('y'), C('franken')); const s3 = sheep(g, H('blue'), B('blue'));
  g.players[1].field = [s1, s2, s3];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  assert.equal(g.pending.stage, 'guess');
  throws(() => applyAction(g, 'p1', { type: 'guess', looking: true }), /guesses/);
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1)); // 0.1 < .5 => looking
  assert.equal(g.pending.winnerId, 'p0');
  assert.equal(g.pending.stage, 'effect'); // Bob has no Re-flip -> skipped
  applyAction(g, 'p0', { type: 'effectChoice', sheepIds: [s1.id, s2.id] });
  assert.equal(g.players[0].field.length, 2);
  assert.equal(g.pending, null);
});

test('ITSLAM wrong guess: opponent uses the effect against the attacker', () => {
  const { g, card } = itslamGame('remove2');
  const mine = [sheep(g, H('red'), B('red')), sheep(g, H('blue'), B('blue')), sheep(g, H('cyan'), B('cyan'))];
  g.players[0].field = [...mine];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: false }, seq(0.1)); // coin looking -> wrong
  assert.equal(g.pending.winnerId, 'p1');
  throws(() => applyAction(g, 'p0', { type: 'effectChoice', sheepIds: [mine[0].id, mine[1].id] }), /winner/);
  applyAction(g, 'p1', { type: 'effectChoice', sheepIds: [mine[0].id, mine[1].id] });
  assert.equal(g.players[0].field.length, 1);
});

test('only one ITSLAM per turn; cannot be discarded at hand limit', () => {
  const g = setup();
  const a = C('itslam', null, { effect: 'yoinkHand' }); const b = C('itslam', null, { effect: 'lure2' });
  g.players[0].hand = [a, b];
  applyAction(g, 'p0', { type: 'itslam', cardId: a.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1)); // yoinkHand auto-resolves
  assert.equal(g.pending, null);
  throws(() => applyAction(g, 'p0', { type: 'itslam', cardId: b.id, targetId: 'p1' }), /one/);
  g.players[0].hand = [b, ...Array.from({ length: 7 }, () => H('grey'))];
  throws(() => applyAction(g, 'p0', { type: 'endTurn', discardIds: [b.id] }), /can't discard/);
  throws(() => applyAction(g, 'p0', { type: 'endTurn', discardIds: [] }), /Discard exactly 1/);
  applyAction(g, 'p0', { type: 'endTurn', discardIds: [g.players[0].hand[1].id] });
  assert.equal(g.players[0].hand.length, HAND_MAX);
});

test('re-flip: loser forces new guess and flip; chains', () => {
  const { g, card } = itslamGame('yoinkHand');
  const rf = C('reflip');
  g.players[1].hand = [rf, H('red'), B('red')];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1)); // p0 wins
  assert.equal(g.pending.stage, 'reflip');
  throws(() => applyAction(g, 'p0', { type: 'acceptFlip' }), /another player/);
  applyAction(g, 'p1', { type: 'reflip', cardId: rf.id });
  assert.equal(g.pending.stage, 'guess');
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.9)); // not looking -> p0 wrong
  assert.equal(g.pending, null); // p0 has no reflip -> auto, yoinkHand auto
  assert.equal(g.players[1].hand.length, 2 + 0); // took p0's empty hand
});

test('halve 2: winner takes chosen halves + modifier, loser gets leftovers', () => {
  const { g, card } = itslamGame('halve2');
  const r = H('red'); const rb = B('red'); const paint = C('paint'); const o = H('orange'); const gb = B('green');
  const s1 = sheep(g, r, rb); const s2 = sheep(g, o, gb, paint);
  g.players[1].field = [s1, s2];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1));
  applyAction(g, 'p0', { type: 'effectChoice', halves: [{ sheepId: s1.id, cardId: r.id }, { sheepId: s2.id, cardId: gb.id }] });
  assert.deepEqual(new Set(g.players[0].hand), new Set([r, gb, paint]));
  assert.deepEqual(new Set(g.players[1].hand), new Set([rb, o]));
  assert.equal(g.players[1].field.length, 0);
});

test('recover 1: winner plays a valid sheep from the discard pile', () => {
  const { g, card } = itslamGame('recover1');
  const h = H('blue'); const b = B('red'); const paint = C('paint');
  g.discard = [h, b, paint, C('wolf')];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1));
  throws(() => applyAction(g, 'p0', { type: 'effectChoice', recover: { cardIds: [h.id, b.id] } }), /Colours/);
  applyAction(g, 'p0', { type: 'effectChoice', recover: { cardIds: [h.id, b.id], modifierId: paint.id } });
  assert.equal(g.players[0].field.length, 1);
  assert.ok(!g.discard.includes(h));
});

test('turn start draws 1 then tops up to 3', () => {
  const g = setup();
  g.players[1].hand = [];
  applyAction(g, 'p0', { type: 'endTurn', discardIds: [] });
  assert.equal(currentPlayer(g).id, 'p1');
  assert.equal(g.players[1].hand.length, 3);
});

test('final round: after deck empties everyone gets one final turn, then scoring', () => {
  const g = setup(3);
  g.deck = [H('grey')]; // p0's end -> p1 draws last card
  applyAction(g, 'p0', { type: 'endTurn', discardIds: [] }); // p1 turn; deck now empty
  assert.equal(g.deckEmptied, true);
  g.players[1].hand = [];
  applyAction(g, 'p1', { type: 'endTurn', discardIds: [] }); // final round starts: p2, p0, p1
  const order = [];
  while (g.phase === 'playing') { order.push(currentPlayer(g).id); currentPlayer(g).hand = []; applyAction(g, currentPlayer(g).id, { type: 'endTurn', discardIds: [] }); }
  assert.deepEqual(order, ['p2', 'p0', 'p1']);
  assert.equal(g.result.tiedIds.length, 3); // all 0 -> tie
  assert.equal(g.result.winners.length, 1); // the coin decides
});

test('views hide other hands', () => {
  const g = setup();
  g.players[1].hand = [H('red')];
  const v = viewFor(g, 'p0');
  assert.equal(v.players[1].hand, undefined);
  assert.equal(v.players[1].handCount, 1);
  assert.ok(Array.isArray(v.players[0].hand));
  assert.equal(JSON.stringify(v).includes('"deck"'), false);
});

test('leaving: game continues with 3, ends with fewer than 2', () => {
  const g = setup(3);
  playerLeaves(g, 'p0');
  assert.equal(currentPlayer(g).id, 'p1');
  assert.equal(g.phase, 'playing');
  playerLeaves(g, 'p2');
  assert.equal(g.phase, 'ended');
  assert.deepEqual(g.result.winners, ['p1']);
});

test('random full games always terminate with consistent card counts', () => {
  for (let k = 0; k < 200; k++) {
    let s = k + 1; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const n = 2 + (k % 3);
    const g = createGame(Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), rng);
    let steps = 0;
    while (g.phase === 'playing' && steps++ < 5000) {
      randomLegalMove(g, rng) || autoAct(g, rng);
      const total = g.deck.length + g.discard.length + g.players.reduce((a, p) => a + p.hand.length + p.field.reduce((b, sh) => b + 2 + (sh.modifier ? 1 : 0), 0), 0);
      assert.equal(total, 54);
    }
    assert.equal(g.phase, 'ended', `game ${k} did not end`);
  }
});

/** Try a few random actions for whoever is up; return true if one succeeded. */
function randomLegalMove(g, rng) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  const actorId = waitingOn(g);
  const me = g.players.find((p) => p.id === actorId);
  const opps = g.players.filter((p) => p.id !== actorId && !p.left);
  for (let tries = 0; tries < 6; tries++) {
    const c = pick(me.hand.length ? me.hand : [{}]);
    const opp = pick(opps);
    const tries2 = [
      { type: 'makeSheep', cardIds: [c.id, pick(me.hand)?.id], modifierId: rng() < 0.3 ? pick(me.hand)?.id : undefined },
      { type: c.kind, cardId: c.id, targetId: opp.id, sheepId: pick(opp.field)?.id },
      { type: 'bodyswap', ownerId: opp.id, sheepId: pick(opp.field)?.id, replaceCardId: pick(opp.field)?.cards[0].id, handCardId: c.id },
    ];
    try { applyAction(g, actorId, pick(tries2), rng); return true; } catch (e) { if (!(e instanceof RuleError)) throw e; }
  }
  return false;
}

test('bodyswap only targets Modified or Half Rainbow sheep, leaving Basic or Full Rainbow behind', () => {
  const g = setup();
  const p = g.players[0];
  // Basic sheep cannot be bodyswapped.
  const basic = sheep(g, H('red'), B('red')); const rb = B('rainbow');
  g.players[1].field = [basic]; p.hand = [rb];
  throws(() => applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: basic.id, replaceCardId: basic.cards[1].id, handCardId: rb.id }), /Modified|Half Rainbow/);
  // Franken red+yellow heads + rainbow butt would leave a Half Rainbow: not allowed.
  const fr = sheep(g, H('red'), H('yellow'), C('franken'));
  g.players[1].field = [fr];
  throws(() => applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: fr.id, replaceCardId: fr.cards[1].id, handCardId: rb.id }), /Basic Sheep or a Full Rainbow/);
  // Half Rainbow (rainbow head + cyan butt) + cyan head -> Basic cyan; swapper takes the rainbow head.
  const rh = H('rainbow'); const half = sheep(g, rh, B('cyan')); const cyanHead = H('cyan');
  g.players[1].field = [half]; p.hand = [cyanHead];
  applyAction(g, 'p0', { type: 'bodyswap', ownerId: 'p1', sheepId: half.id, replaceCardId: rh.id, handCardId: cyanHead.id });
  assert.deepEqual(p.hand, [rh]);
});

test('rainbow frankensheep (2 rainbow heads) is a Full Rainbow worth 2', () => {
  const g = setup();
  g.players[0].field = [sheep(g, H('rainbow'), H('rainbow'), C('franken'))];
  assert.equal(scoreOf(g.players[0]).sheep, 2);
});

test('wolf may target your own field too', () => {
  const g = setup();
  const w = C('wolf'); const s = sheep(g, H('red'), B('red'));
  g.players[0].field = [s]; g.players[0].hand = [w];
  applyAction(g, 'p0', { type: 'wolf', cardId: w.id, targetId: 'p0', sheepId: s.id });
  assert.equal(g.players[0].field.length, 0);
});

test('re-flip can be played by a player the flip does not affect; holder is hidden from others', () => {
  const g = setup(3);
  const card = C('itslam', null, { effect: 'yoinkHand' }); const rf = C('reflip');
  g.players[0].hand = [card]; g.players[2].hand = [rf];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1)); // p0 wins
  assert.equal(g.pending.stage, 'reflip');
  assert.equal(viewFor(g, 'p2').waitingOn, 'p2');
  assert.equal(viewFor(g, 'p0').waitingOn, null);
  throws(() => applyAction(g, 'p1', { type: 'acceptFlip' }), /another player/);
  applyAction(g, 'p2', { type: 'reflip', cardId: rf.id });
  assert.equal(g.pending.stage, 'guess');
});

test('hand-limit discards go face down and stay hidden from other players', () => {
  const g = setup();
  g.players[0].hand = Array.from({ length: 8 }, () => H('grey'));
  const d = g.players[0].hand[0];
  applyAction(g, 'p0', { type: 'endTurn', discardIds: [d.id] });
  const v = viewFor(g, 'p1');
  assert.deepEqual(v.discard.at(-1), { id: d.id, faceDown: true });
});

test('consequential events carry structured data for bubbles/sounds; routine ones do not', () => {
  const g = setup();
  const [a, b] = [H('red'), B('red')];
  const wolf = C('wolf'); const target = sheep(g, H('cyan'), B('cyan'));
  g.players[1].field = [target];
  g.players[0].hand = [a, b, wolf];
  applyAction(g, 'p0', { type: 'makeSheep', cardIds: [a.id, b.id] });
  assert.equal(g.log.at(-1).ev, undefined); // ordinary sheep: no bubble
  applyAction(g, 'p0', { type: 'wolf', cardId: wolf.id, targetId: 'p1', sheepId: target.id });
  assert.deepEqual(g.log.at(-1).ev, { kind: 'wolf', actor: 'p0', target: 'p1', art: 'wolf' });
  const rh = H('rainbow'); const rb = B('rainbow'); g.players[0].hand = [rh, rb];
  applyAction(g, 'p0', { type: 'makeSheep', cardIds: [rh.id, rb.id] });
  assert.equal(g.log.at(-1).ev.kind, 'rainbow');
  applyAction(g, 'p0', { type: 'endTurn', discardIds: [] });
  assert.ok(g.log.slice(-2).every((e) => !e.ev)); // "Baa" and turn draw are routine
});

test('flip and challenge effects emit events naming winner and loser', () => {
  const { g, card } = itslamGame('yoinkHand');
  g.players[1].hand = [H('red')];
  applyAction(g, 'p0', { type: 'itslam', cardId: card.id, targetId: 'p1' });
  assert.equal(g.log.at(-1).ev.kind, 'challenge');
  applyAction(g, 'p0', { type: 'guess', looking: true }, seq(0.1));
  const evs = g.log.filter((e) => e.ev).map((e) => e.ev);
  const flip = evs.find((e) => e.kind === 'flip');
  assert.deepEqual([flip.winner, flip.loser, flip.looking], ['p0', 'p1', true]);
  const eff = evs.find((e) => e.kind === 'effect');
  assert.deepEqual([eff.effect, eff.actor, eff.target, eff.count], ['yoinkHand', 'p0', 'p1', 1]);
});
