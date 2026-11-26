// Authoritative rules engine. Pure state transitions; all randomness through `rng`.
import {
  buildDeck, isHalf, isModifier, isValidSheep, isNaturalMatch, sheepPoints,
  isDoubleHeadFranken, isDoubleButtFranken, cardLabel, ITSLAM_EFFECTS, canBodyswap, isBodyswappable, isFullRainbow,
} from '../shared/cards.js';

export const HAND_START = 5;
export const HAND_MIN = 3;
export const HAND_MAX = 7;
export const ITSLAM_PENALTY = 3;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

/** rng(): float in [0,1). */
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createGame(players, rng = Math.random, opts = {}) {
  if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) fail(`Need ${MIN_PLAYERS}-${MAX_PLAYERS} players`);
  const deck = shuffle(opts.deck ?? buildDeck(), rng);
  const state = {
    players: players.map((p) => ({ id: p.id, name: p.name, hand: [], field: [], left: false })),
    deck,
    discard: [],
    turn: Math.floor(rng() * players.length),
    turnNumber: 0,
    itslamPlayedThisTurn: false,
    deckEmptied: false,
    finalQueue: null,
    pending: null,
    phase: 'playing',
    result: null,
    log: [],
    seq: 0,
    nextSheepId: 1,
  };
  Object.defineProperty(state, 'rng', { value: rng, enumerable: false, writable: true });
  for (let r = 0; r < HAND_START; r++) for (const p of state.players) p.hand.push(state.deck.pop());
  log(state, `Dealt ${HAND_START} cards to each player. ${state.players[state.turn].name} goes first.`);
  startTurn(state);
  return state;
}

/**
 * Append to the game log. `ev` (optional) marks a consequential event with structured data
 * that clients use for action bubbles and sounds; routine entries carry none.
 */
function log(state, text, ev) {
  state.log.push(ev ? { n: ++state.seq, text, ev } : { n: ++state.seq, text });
  if (state.log.length > 200) state.log.shift();
}

const player = (state, id) => state.players.find((p) => p.id === id) ?? fail('Unknown player');
export const currentPlayer = (state) => state.players[state.turn];

function takeFromHand(p, cardId, pred, what) {
  const i = p.hand.findIndex((c) => c.id === cardId);
  if (i < 0) fail('That card is not in your hand');
  if (pred && !pred(p.hand[i])) fail(`That card is not ${what}`);
  return p.hand.splice(i, 1)[0];
}
function peekHand(p, cardId) {
  return p.hand.find((c) => c.id === cardId) ?? fail('That card is not in your hand');
}
function findSheep(p, sheepId) {
  return p.field.find((s) => s.id === sheepId) ?? fail('No such sheep in that field');
}
function removeSheep(p, sheepId) {
  const i = p.field.findIndex((s) => s.id === sheepId);
  if (i < 0) fail('No such sheep in that field');
  return p.field.splice(i, 1)[0];
}
const article = (w) => `${/^[AEIOU]/i.test(w) ? 'an' : 'a'} ${w}`;
function sheepCards(s) { return s.modifier ? [...s.cards, s.modifier] : [...s.cards]; }
function sheepName(s) {
  const base = s.cards.map(cardLabel).join(' + ');
  return s.modifier ? `${base} (${cardLabel(s.modifier)})` : base;
}
function drawOne(state, p) {
  if (!state.deck.length) return false;
  p.hand.push(state.deck.pop());
  if (!state.deck.length && !state.deckEmptied) {
    state.deckEmptied = true;
    log(state, 'The draw pile is empty! The final round begins after this turn.');
  }
  return true;
}

function startTurn(state) {
  const p = currentPlayer(state);
  state.turnNumber++;
  state.itslamPlayedThisTurn = false;
  let drawn = 0;
  if (drawOne(state, p)) drawn++;
  while (p.hand.length < HAND_MIN && drawOne(state, p)) drawn++;
  log(state, `${p.name}'s turn${state.finalQueue ? ' (final turn)' : ''}: drew ${drawn} card${drawn === 1 ? '' : 's'}.`);
}

function activePlayers(state) { return state.players.filter((p) => !p.left); }

function nextActiveIndex(state, from) {
  const n = state.players.length;
  let t = from;
  for (let i = 0; i < n; i++) { t = (t + 1) % n; if (!state.players[t].left) return t; }
  return from;
}

function advanceTurn(state) {
  if (!state.finalQueue && state.deckEmptied) {
    // Everyone (still playing) gets one final turn, starting with the next player.
    const q = [];
    let t = state.turn;
    for (let i = 0; i < state.players.length; i++) { t = (t + 1) % state.players.length; if (!state.players[t].left) q.push(state.players[t].id); }
    state.finalQueue = q;
    log(state, 'Final round: everyone gets one final turn.', { kind: 'finalRound' });
  }
  if (state.finalQueue) {
    const next = state.finalQueue.shift();
    if (next == null) return endGame(state, undefined, state.rng);
    state.turn = state.players.findIndex((p) => p.id === next);
  } else {
    state.turn = nextActiveIndex(state, state.turn);
  }
  startTurn(state);
}

export function scoreOf(p) {
  const sheep = p.field.reduce((sum, s) => sum + sheepPoints(s), 0);
  const itslam = p.hand.filter((c) => c.kind === 'itslam').length;
  return { sheep, penalty: itslam * ITSLAM_PENALTY, total: sheep - itslam * ITSLAM_PENALTY, sheepCount: p.field.length, itslamInHand: itslam };
}

function endGame(state, reason = 'The final round is over.', rng = Math.random) {
  state.phase = 'ended';
  state.pending = null;
  const scores = state.players.map((p) => ({ id: p.id, name: p.name, left: p.left, ...scoreOf(p) }));
  const eligible = scores.filter((s) => !s.left);
  const best = Math.max(...eligible.map((s) => s.total));
  const tied = eligible.filter((s) => s.total === best).map((s) => s.id);
  // "In the event of a tie, flip the coin to decide the winner." (3+ tied: the coin picks among them.)
  const winner = tied.length > 1 ? tied[Math.floor(rng() * tied.length)] : tied[0];
  state.result = { scores, winners: [winner], tiedIds: tied.length > 1 ? tied : [], reason };
  if (tied.length > 1) log(state, `${reason} Tie at ${best} points between ${tied.map((id) => player(state, id).name).join(' & ')}. The sheep coin decides…`);
  log(state, `Winner: ${player(state, winner).name} with ${best} points!`, { kind: 'win', actor: winner, tie: tied.length > 1 });
}

// ---------- Public action dispatcher ----------

/**
 * Apply an action from playerId. Throws RuleError on invalid input.
 * Returns nothing; mutates state.
 */
export function applyAction(state, playerId, action, rng = Math.random) {
  if (state.phase !== 'playing') fail('The game is over');
  if (!action || typeof action.type !== 'string') fail('Bad action');
  const me = player(state, playerId);
  if (me.left) fail('You have left this game');

  if (state.pending) return handlePending(state, me, action, rng);

  if (currentPlayer(state).id !== playerId) fail('It is not your turn');
  switch (action.type) {
    case 'makeSheep': return makeSheep(state, me, action);
    case 'bodyswap': return bodyswap(state, me, action);
    case 'yoink': return yoink(state, me, action, rng);
    case 'wheat': return wheat(state, me, action);
    case 'wolf': return wolf(state, me, action);
    case 'itslam': return playItslam(state, me, action);
    case 'endTurn': return endTurn(state, me, action, rng);
    default: fail('That action is not available right now');
  }
}

function makeSheep(state, me, { cardIds, modifierId }) {
  if (!Array.isArray(cardIds) || cardIds.length !== 2 || cardIds[0] === cardIds[1]) fail('Pick two sheep halves');
  const a = peekHand(me, cardIds[0]);
  const b = peekHand(me, cardIds[1]);
  const m = modifierId ? peekHand(me, modifierId) : null;
  if (m && !isModifier(m)) fail('That is not a modifier card');
  if (!isValidSheep(a, b, m)) fail(invalidSheepReason(a, b, m));
  for (const id of [cardIds[0], cardIds[1], modifierId].filter(Boolean)) takeFromHand(me, id);
  const sheep = { id: `s${state.nextSheepId++}`, cards: [a, b], modifier: m };
  me.field.push(sheep);
  log(state, `${me.name} made a sheep: ${sheepName(sheep)}.`, isFullRainbow(sheep) ? { kind: 'rainbow', actor: me.id, art: a.art } : undefined);
}

function invalidSheepReason(a, b, m) {
  if (!isHalf(a) || !isHalf(b)) return 'A sheep needs two head/butt cards';
  if (!m) return a.kind === b.kind ? 'Two of the same half needs a Franken modifier' : 'Colours must match (or use a rainbow or Paint)';
  if (m.kind === 'paint') return 'Paint combines one head and one butt';
  return 'Franken combines two heads or two butts';
}

function bodyswap(state, me, { ownerId, sheepId, replaceCardId, handCardId }) {
  const owner = player(state, ownerId);
  if (owner.left) fail('That player has left');
  const sheep = findSheep(owner, sheepId);
  const newCard = peekHand(me, handCardId);
  if (!isHalf(newCard)) fail('Bodyswap with a head or butt card');
  const idx = sheep.cards.findIndex((c) => c.id === replaceCardId);
  if (idx < 0) fail('That card is not part of the sheep');
  if (!isBodyswappable(sheep)) fail('You can only bodyswap Modified sheep (Paint/Franken) or Half Rainbow sheep');
  if (!canBodyswap(sheep, idx, newCard)) fail('A bodyswap must leave a Basic Sheep or a Full Rainbow Sheep behind');
  takeFromHand(me, handCardId);
  const removed = sheep.cards[idx];
  sheep.cards[idx] = newCard;
  me.hand.push(removed);
  let extra = '';
  if (sheep.modifier) { me.hand.push(sheep.modifier); extra = ` and the ${cardLabel(sheep.modifier)} card`; sheep.modifier = null; }
  const where = owner.id === me.id ? 'their own' : `${owner.name}'s`;
  const ev = owner.id !== me.id || isFullRainbow(sheep) ? { kind: 'bodyswap', actor: me.id, target: owner.id, art: newCard.art, rainbow: isFullRainbow(sheep) } : undefined;
  log(state, `${me.name} bodyswapped a sheep in ${where} field with ${article(cardLabel(newCard))}, taking the ${cardLabel(removed)}${extra}.`, ev);
}

function opponent(state, me, targetId) {
  if (targetId === me.id) fail('Choose an opponent');
  const t = player(state, targetId);
  if (t.left) fail('That player has left');
  return t;
}

function yoink(state, me, { cardId, targetId }, rng) {
  peekHand(me, cardId).kind === 'yoink' || fail('That is not a Yoink! card');
  const t = opponent(state, me, targetId);
  if (!t.hand.length) fail(`${t.name} has no cards to yoink`);
  state.discard.push(takeFromHand(me, cardId));
  const n = Math.min(2, t.hand.length);
  for (let i = 0; i < n; i++) me.hand.push(t.hand.splice(Math.floor(rng() * t.hand.length), 1)[0]);
  log(state, `${me.name} played Yoink! and stole ${n} card${n > 1 ? 's' : ''} from ${t.name}.`, { kind: 'yoink', actor: me.id, target: t.id, count: n, art: 'yoink' });
}

export function wheatProtected(p) { return p.field.some(isDoubleButtFranken); }
export function wolfProtected(p) { return p.field.some(isDoubleHeadFranken); }

function anyPlayer(state, targetId) {
  const t = player(state, targetId);
  if (t.left) fail('That player has left');
  return t;
}

function wheat(state, me, { cardId, targetId, sheepId }) {
  peekHand(me, cardId).kind === 'wheat' || fail('That is not a Wheat card');
  const t = anyPlayer(state, targetId);
  if (wheatProtected(t)) fail(`${t.name}'s double-butted frankensheep has no mouth — Wheat can't lure their sheep`);
  findSheep(t, sheepId);
  state.discard.push(takeFromHand(me, cardId));
  const s = removeSheep(t, sheepId);
  me.field.push(s);
  log(state, t.id === me.id ? `${me.name} used Wheat on their own ${sheepName(s)} (it stays put).` : `${me.name} used Wheat to lure ${sheepName(s)} from ${t.name}.`,
    t.id === me.id ? undefined : { kind: 'wheat', actor: me.id, target: t.id, art: 'wheat' });
}

function wolf(state, me, { cardId, targetId, sheepId }) {
  peekHand(me, cardId).kind === 'wolf' || fail('That is not a Wolf card');
  const t = anyPlayer(state, targetId);
  if (wolfProtected(t)) fail(`${t.name}'s double-headed frankensheep sees the wolf coming — no wolfing them`);
  findSheep(t, sheepId);
  state.discard.push(takeFromHand(me, cardId));
  const s = removeSheep(t, sheepId);
  state.discard.push(...sheepCards(s));
  log(state, `${me.name} sent a Wolf after ${t.id === me.id ? 'their own' : `${t.name}'s`} ${sheepName(s)}. It's gone!`, { kind: 'wolf', actor: me.id, target: t.id, art: 'wolf' });
}

function playItslam(state, me, { cardId, targetId }) {
  const card = peekHand(me, cardId);
  if (card.kind !== 'itslam') fail('That is not an "Is That Sheep Looking At Me?" card');
  if (state.itslamPlayedThisTurn) fail('Only one "Is That Sheep Looking At Me?" card per turn');
  const t = opponent(state, me, targetId);
  state.discard.push(takeFromHand(me, cardId));
  state.itslamPlayedThisTurn = true;
  state.pending = {
    type: 'flip', stage: 'guess', effect: card.effect, attackerId: me.id, defenderId: t.id,
    guess: null, coin: null, winnerId: null, loserId: null, flips: 0, deadlineMs: null,
  };
  log(state, `${me.name} played "Is That Sheep Looking At Me?" (${ITSLAM_EFFECTS[card.effect].name}) at ${t.name}!`, { kind: 'challenge', actor: me.id, target: t.id, effect: card.effect, art: card.art });
}

function endTurn(state, me, { discardIds = [] }) {
  if (!Array.isArray(discardIds)) fail('Bad discard list');
  const need = Math.max(0, me.hand.length - HAND_MAX);
  if (new Set(discardIds).size !== discardIds.length) fail('Duplicate discard');
  if (discardIds.length !== need) fail(need ? `Discard exactly ${need} card${need > 1 ? 's' : ''} to get down to ${HAND_MAX}` : 'You do not need to discard');
  for (const id of discardIds) if (peekHand(me, id).kind === 'itslam') fail('You can\'t discard an "Is That Sheep Looking At Me?" card');
  for (const id of discardIds) state.discard.push({ ...takeFromHand(me, id), faceDown: true });
  log(state, `${me.name}${need ? ` discarded ${need} face down and` : ''} said "Baa!"`);
  advanceTurn(state);
}

// ---------- Coin flip / ITSLAM resolution ----------

function handlePending(state, me, action, rng) {
  const pd = state.pending;
  if (pd.stage === 'guess') {
    if (action.type !== 'guess') fail('Waiting for the coin guess');
    if (me.id !== pd.attackerId) fail('Only the player who played the card guesses');
    if (typeof action.looking !== 'boolean') fail('Guess looking or not looking');
    pd.guess = action.looking;
    pd.coin = rng() < 0.5; // true = sheep is looking at you
    pd.flips++;
    const right = pd.guess === pd.coin;
    pd.winnerId = right ? pd.attackerId : pd.defenderId;
    pd.loserId = right ? pd.defenderId : pd.attackerId;
    const a = player(state, pd.attackerId);
    log(state, `${a.name} guessed "${pd.guess ? 'looking' : 'not looking'}"… the sheep ${pd.coin ? 'IS' : 'is NOT'} looking! ${right ? `${a.name} wins the flip.` : `Wrong! ${player(state, pd.defenderId).name} gets the effect.`}`,
      { kind: 'flip', actor: pd.attackerId, target: pd.defenderId, looking: pd.coin, winner: pd.winnerId, loser: pd.loserId });
    pd.stage = 'reflip';
    return maybeSkipReflip(state, rng);
  }
  if (pd.stage === 'reflip') {
    if (me.id !== pd.reflipAsk) fail('Waiting for another player to decide on a Re-flip');
    if (action.type === 'acceptFlip') { pd.reflipPassed.push(me.id); return nextReflipAsk(state, rng); }
    if (action.type === 'reflip') {
      const c = peekHand(me, action.cardId);
      if (c.kind !== 'reflip') fail('That is not a Re-flip card');
      state.discard.push(takeFromHand(me, action.cardId));
      log(state, `${me.name} played Re-flip! New guess, new flip.`, { kind: 'reflip', actor: me.id, art: 'reflip' });
      pd.stage = 'guess'; pd.guess = null; pd.coin = null; pd.winnerId = null; pd.loserId = null; pd.reflipAsk = null;
      return;
    }
    fail('Accept the flip or play a Re-flip');
  }
  if (pd.stage === 'effect') {
    if (action.type !== 'effectChoice') fail('Waiting for the flip winner to choose');
    if (me.id !== pd.winnerId) fail('Only the flip winner chooses');
    return resolveEffect(state, action, rng);
  }
  fail('Unexpected state');
}

/**
 * After a flip, anyone holding a Re-flip may play it ("even if it doesn't directly affect you").
 * Holders are asked one at a time: the flip loser first, then the others in seat order.
 */
function maybeSkipReflip(state, rng) {
  state.pending.reflipPassed = [];
  nextReflipAsk(state, rng);
}

function nextReflipAsk(state, rng) {
  const pd = state.pending;
  const n = state.players.length;
  const start = state.players.findIndex((p) => p.id === pd.loserId);
  for (let i = 0; i < n; i++) {
    const p = state.players[(start + i) % n];
    if (!p.left && !pd.reflipPassed.includes(p.id) && p.hand.some((c) => c.kind === 'reflip')) { pd.reflipAsk = p.id; return; }
  }
  pd.reflipAsk = null;
  pd.stage = 'effect';
  maybeAutoResolve(state, rng);
}

/** Options the winner can choose from, or null if nothing to choose. */
export function effectOptions(state) {
  const pd = state.pending;
  if (!pd || pd.stage !== 'effect') return null;
  const loser = player(state, pd.loserId);
  switch (pd.effect) {
    case 'lure2': case 'remove2': case 'halve2':
      return { pick: Math.min(2, loser.field.length), sheep: loser.field.map((s) => s.id) };
    case 'recover1':
      return { recoverPossible: discardHasValidSheep(state.discard) };
    default: return {};
  }
}

export function discardHasValidSheep(cards) {
  const halves = cards.filter(isHalf);
  const mods = cards.filter(isModifier);
  for (let i = 0; i < halves.length; i++) for (let j = i + 1; j < halves.length; j++) {
    if (isValidSheep(halves[i], halves[j])) return true;
    if (mods.some((m) => isValidSheep(halves[i], halves[j], m))) return true;
  }
  return false;
}

function maybeAutoResolve(state, rng) {
  const pd = state.pending;
  const loser = player(state, pd.loserId);
  const opts = effectOptions(state);
  if (pd.effect === 'yoinkHand') return resolveEffect(state, { type: 'effectChoice' }, rng);
  if (['lure2', 'remove2'].includes(pd.effect) && loser.field.length <= 2) {
    return resolveEffect(state, { type: 'effectChoice', sheepIds: loser.field.map((s) => s.id) }, rng);
  }
  if (pd.effect === 'halve2' && loser.field.length === 0) return resolveEffect(state, { type: 'effectChoice', halves: [] }, rng);
  if (pd.effect === 'recover1' && !opts.recoverPossible) return resolveEffect(state, { type: 'effectChoice', recover: null }, rng);
}

function resolveEffect(state, choice, _rng) {
  const pd = state.pending;
  const winner = player(state, pd.winnerId);
  const loser = player(state, pd.loserId);
  const need = Math.min(2, loser.field.length);
  switch (pd.effect) {
    case 'lure2':
    case 'remove2': {
      const ids = choice.sheepIds;
      if (!Array.isArray(ids) || ids.length !== need || new Set(ids).size !== ids.length) fail(`Choose ${need} sheep`);
      ids.forEach((id) => findSheep(loser, id));
      for (const id of ids) {
        const s = removeSheep(loser, id);
        if (pd.effect === 'lure2') winner.field.push(s); else state.discard.push(...sheepCards(s));
      }
      log(state, need === 0 ? `${loser.name} had no sheep — nothing happens.` : `${winner.name} ${pd.effect === 'lure2' ? 'lured' : 'removed'} ${need} sheep from ${loser.name}'s field.`,
        { kind: 'effect', effect: pd.effect, actor: winner.id, target: loser.id, count: need, art: `itslam-${pd.effect}` });
      break;
    }
    case 'yoinkHand': {
      const n = loser.hand.length;
      winner.hand.push(...loser.hand.splice(0));
      log(state, `${winner.name} yoinked ${loser.name}'s entire hand (${n} card${n === 1 ? '' : 's'})!`, { kind: 'effect', effect: pd.effect, actor: winner.id, target: loser.id, count: n, art: 'itslam-yoinkHand' });
      break;
    }
    case 'halve2': {
      const halves = choice.halves;
      if (!Array.isArray(halves) || halves.length !== need) fail(`Choose a half from ${need} sheep`);
      if (new Set(halves.map((h) => h?.sheepId)).size !== halves.length) fail('Choose two different sheep');
      for (const h of halves) {
        const s = findSheep(loser, h.sheepId);
        if (!s.cards.some((c) => c.id === h.cardId)) fail('Pick a head or butt of that sheep');
      }
      for (const h of halves) {
        const s = removeSheep(loser, h.sheepId);
        const taken = s.cards.find((c) => c.id === h.cardId);
        const left = s.cards.find((c) => c.id !== h.cardId);
        winner.hand.push(taken);
        if (s.modifier) winner.hand.push(s.modifier);
        loser.hand.push(left);
      }
      log(state, need ? `${winner.name} halved ${need} of ${loser.name}'s sheep. ${loser.name} picks up the leftovers.` : `${loser.name} had no sheep to halve.`,
        { kind: 'effect', effect: pd.effect, actor: winner.id, target: loser.id, count: need, art: 'itslam-halve2' });
      break;
    }
    case 'recover1': {
      if (choice.recover == null) {
        if (discardHasValidSheep(state.discard)) fail('Pick a valid sheep from the discard pile');
        log(state, `No valid sheep in the discard pile for ${winner.name} to recover.`, { kind: 'effect', effect: 'recover1', actor: winner.id, count: 0, art: 'itslam-recover1' });
        break;
      }
      const { cardIds, modifierId } = choice.recover;
      if (!Array.isArray(cardIds) || cardIds.length !== 2 || cardIds[0] === cardIds[1]) fail('Pick two halves from the discard pile');
      const get = (id) => state.discard.find((c) => c.id === id) ?? fail('That card is not in the discard pile');
      const a = get(cardIds[0]); const b = get(cardIds[1]); const m = modifierId ? get(modifierId) : null;
      if (!isValidSheep(a, b, m)) fail(invalidSheepReason(a, b, m));
      state.discard = state.discard.filter((c) => ![a.id, b.id, m?.id].includes(c.id));
      for (const c of [a, b, m]) if (c) delete c.faceDown;
      const sheep = { id: `s${state.nextSheepId++}`, cards: [a, b], modifier: m };
      winner.field.push(sheep);
      log(state, `${winner.name} recovered ${sheepName(sheep)} from the discard pile.`, { kind: 'effect', effect: 'recover1', actor: winner.id, count: 1, art: 'itslam-recover1' });
      break;
    }
    default: fail('Unknown effect');
  }
  state.pending = null;
}

// ---------- Timeouts / disconnects ----------

/**
 * Make a safe automatic decision for whoever the game is waiting on.
 * Used when a player times out or disconnects. Returns true if something happened.
 */
export function autoAct(state, rng = Math.random) {
  if (state.phase !== 'playing') return false;
  const pd = state.pending;
  if (pd) {
    if (pd.stage === 'guess') return applyAction(state, pd.attackerId, { type: 'guess', looking: rng() < 0.5 }, rng), true;
    if (pd.stage === 'reflip') return applyAction(state, pd.reflipAsk, { type: 'acceptFlip' }, rng), true;
    if (pd.stage === 'effect') {
      const loser = player(state, pd.loserId);
      const pickN = (arr, n) => shuffle([...arr], rng).slice(0, n);
      const n = Math.min(2, loser.field.length);
      let choice = { type: 'effectChoice' };
      if (pd.effect === 'lure2' || pd.effect === 'remove2') choice.sheepIds = pickN(loser.field, n).map((s) => s.id);
      if (pd.effect === 'halve2') choice.halves = pickN(loser.field, n).map((s) => ({ sheepId: s.id, cardId: s.cards[0].id }));
      if (pd.effect === 'recover1') choice.recover = findAnyRecover(state.discard);
      return applyAction(state, pd.winnerId, choice, rng), true;
    }
  }
  const p = currentPlayer(state);
  const need = Math.max(0, p.hand.length - HAND_MAX);
  const discardable = p.hand.filter((c) => c.kind !== 'itslam');
  applyAction(state, p.id, { type: 'endTurn', discardIds: pickRandom(discardable, need, rng).map((c) => c.id) }, rng);
  return true;
}

function pickRandom(arr, n, rng) { return shuffle([...arr], rng).slice(0, n); }

function findAnyRecover(cards) {
  const halves = cards.filter(isHalf);
  const mods = cards.filter(isModifier);
  let fallback = null;
  for (let i = 0; i < halves.length; i++) for (let j = i + 1; j < halves.length; j++) {
    if (isValidSheep(halves[i], halves[j])) return { cardIds: [halves[i].id, halves[j].id] };
    const m = mods.find((mm) => isValidSheep(halves[i], halves[j], mm));
    if (m && !fallback) fallback = { cardIds: [halves[i].id, halves[j].id], modifierId: m.id };
  }
  return fallback;
}

/** Who the game is waiting on right now (player id). */
export function waitingOn(state) {
  if (state.phase !== 'playing') return null;
  const pd = state.pending;
  if (!pd) return currentPlayer(state).id;
  if (pd.stage === 'guess') return pd.attackerId;
  if (pd.stage === 'reflip') return pd.reflipAsk;
  return pd.winnerId;
}

/** A player leaves permanently. Their cards stay where they are; they are skipped. */
export function playerLeaves(state, playerId, rng = Math.random) {
  const p = player(state, playerId);
  if (p.left || state.phase !== 'playing') return;
  const wasTurn = currentPlayer(state).id === playerId;
  // Resolve whatever is waiting on them (or, on their own turn, the whole pending flip).
  let guard = 0;
  while (state.phase === 'playing' && state.pending && (wasTurn || waitingOn(state) === playerId) && guard++ < 10) autoAct(state, rng);
  p.left = true;
  log(state, `${p.name} left the game.`, { kind: 'left', actor: p.id });
  if (state.finalQueue) state.finalQueue = state.finalQueue.filter((id) => id !== playerId);
  if (activePlayers(state).length < MIN_PLAYERS) return endGame(state, 'Not enough players remain.', state.rng);
  if (wasTurn) advanceTurn(state);
}

// ---------- Views ----------

/** What a given viewer is allowed to see. Hidden: other hands and the deck order. */
export function viewFor(state, viewerId) {
  const pd = state.pending;
  // The Recover winner goes through the whole discard pile; everyone else sees face-down cards as backs.
  const seesAll = pd?.stage === 'effect' && pd.effect === 'recover1' && pd.winnerId === viewerId;
  let waiting = waitingOn(state);
  // Don't reveal who is holding a Re-flip.
  if (pd?.stage === 'reflip' && waiting !== viewerId) waiting = null;
  return {
    phase: state.phase,
    turnPlayerId: state.phase === 'playing' ? currentPlayer(state).id : null,
    turnNumber: state.turnNumber,
    waitingOn: waiting,
    deckCount: state.deck.length,
    discard: state.discard.map((c) => (c.faceDown && !seesAll ? { id: c.id, faceDown: true } : c)),
    finalRound: !!state.finalQueue || state.deckEmptied,
    finalTurnsRemaining: state.finalQueue ? state.finalQueue.length + 1 : null,
    itslamPlayedThisTurn: state.itslamPlayedThisTurn,
    players: state.players.map((p) => ({
      id: p.id, name: p.name, left: p.left,
      handCount: p.hand.length,
      hand: p.id === viewerId ? p.hand : undefined,
      field: p.field,
      wheatProtected: wheatProtected(p),
      wolfProtected: wolfProtected(p),
      score: scoreOf(p).sheep,
    })),
    pending: pd ? { ...pd, reflipPassed: undefined, reflipAsk: pd.reflipAsk === viewerId ? viewerId : null, options: effectOptions(state) } : null,
    result: state.result,
    log: state.log.slice(-40),
  };
}
