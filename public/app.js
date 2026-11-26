import {
  COLORS, RAINBOW, CARD_INFO, ITSLAM_EFFECTS, isHalf, isModifier, isValidSheep, isFullRainbow, cardLabel, canBodyswap, isBodyswappable,
} from '/shared/cards.js';

const HAND_MAX = 7;
const app = document.getElementById('app');
const connEl = document.getElementById('conn');
const toastEl = document.getElementById('toast');
const rulesDialog = document.getElementById('rules-dialog');
document.getElementById('btn-rules').addEventListener('click', () => rulesDialog.showModal());
const typesDialog = document.getElementById('types-dialog');
document.getElementById('btn-types').addEventListener('click', () => {
  document.getElementById('types-dialog-body').replaceChildren(cardTypesSection('types-dialog-title'));
  typesDialog.showModal();
});

// ---------- state ----------
const S = {
  connected: false, room: null, game: null, you: null, skew: 0,
  sel: new Set(), discardMode: false, effectSel: [], halves: new Map(), recoverSel: [],
  leaveArm: false, busy: false, lastLogN: 0, prefillCode: null,
  sheepSig: null, fresh: new Map(),
};
const CREDS_KEY = 'sheep:creds';
const NAME_KEY = 'sheep:name';
const loadCreds = () => { try { return JSON.parse(localStorage.getItem(CREDS_KEY)); } catch { return null; } };
const saveCreds = (c) => { try { c ? localStorage.setItem(CREDS_KEY, JSON.stringify(c)) : localStorage.removeItem(CREDS_KEY); } catch {} };
const savedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };

const urlCode = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})/)?.[1]?.toUpperCase() ?? null;
S.prefillCode = urlCode;

// ---------- socket ----------
// eslint-disable-next-line no-undef
const socket = io({ transports: ['websocket', 'polling'] });
function emit(event, payload = {}) {
  return new Promise((resolve) => {
    if (!socket.connected) { toast('Not connected — retrying…'); return resolve({ error: 'offline' }); }
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) { toast('The server did not respond. Check your connection.'); return resolve({ error: 'timeout' }); }
      if (res?.error) toast(res.error);
      resolve(res ?? {});
    });
  });
}
async function act(action) {
  if (S.busy) return;
  S.busy = true;
  const res = await emit('game:action', { action });
  S.busy = false;
  if (!res.error) { S.sel.clear(); S.effectSel = []; S.halves.clear(); S.recoverSel = []; S.discardMode = false; }
  render();
  return res;
}

socket.on('connect', async () => {
  S.connected = true; setConn();
  const c = loadCreds();
  if (c && (!urlCode || urlCode === c.code)) {
    const res = await emit('room:resume', c);
    if (res.error) { saveCreds(null); S.room = null; S.game = null; render(); }
  } else render();
});
socket.on('disconnect', () => { S.connected = false; setConn(); render(); });
socket.io.on('reconnect_attempt', () => setConn('Reconnecting…'));
socket.on('state', (msg) => {
  S.room = msg.room; S.game = msg.game; S.you = msg.you;
  S.skew = msg.room.serverNow - Date.now();
  if (S.room && location.pathname !== `/r/${S.room.code}`) history.replaceState(null, '', `/r/${S.room.code}`);
  const n = S.game?.log.at(-1)?.n ?? 0;
  if (n !== S.lastLogN) { S.lastLogN = n; }
  // Drop selections that no longer exist.
  const me = myPlayer();
  if (me?.hand) for (const id of [...S.sel]) if (!me.hand.some((c) => c.id === id)) S.sel.delete(id);
  if (!S.game?.pending || S.game.pending.stage !== 'effect') { S.effectSel = []; S.halves.clear(); S.recoverSel = []; }
  markFreshSheep();
  render();
});

/** Highlight sheep that just arrived in (or changed in) any field, so every player sees each move. */
const FRESH_MS = 5000;
function markFreshSheep() {
  if (!S.game) { S.sheepSig = null; return; }
  const sig = new Map();
  for (const p of S.game.players) for (const sh of p.field) {
    sig.set(sh.id, `${p.id}|${sh.cards.map((c) => c.id).join(',')}|${sh.modifier?.id ?? ''}`);
  }
  const now = Date.now();
  if (S.sheepSig) for (const [id, v] of sig) if (S.sheepSig.get(id) !== v) S.fresh.set(id, now + FRESH_MS);
  for (const [id, until] of S.fresh) if (until <= now || !sig.has(id)) S.fresh.delete(id);
  S.sheepSig = sig;
  if (S.fresh.size) setTimeout(() => { const t = Date.now(); let changed = false; for (const [id, u] of S.fresh) if (u <= t) { S.fresh.delete(id); changed = true; } if (changed) render(); }, FRESH_MS + 50);
}

function setConn(text) {
  connEl.textContent = text ?? (S.connected ? 'Online' : 'Reconnecting…');
  connEl.className = 'pill ' + (S.connected ? 'ok' : 'bad');
}

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3800);
}

// ---------- DOM helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with trusted, generated SVG strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const colorOf = (id) => (id === RAINBOW ? null : COLORS.find((c) => c.id === id));
const colorName = (id) => (id === RAINBOW ? 'Rainbow' : colorOf(id)?.name ?? id);
const MOD_ICON = { paint: 'Paint', franken: 'Franken' };

/** A card drawn with its official Print & Play artwork (or the card back when face down). */
function cardEl(card, { selected, disabled, onclick, small, label } = {}) {
  const faceDown = card.faceDown && !card.kind;
  const name = faceDown ? 'Face-down card' : cardLabel(card);
  const info = faceDown ? '' : card.kind === 'itslam' ? `. Challenge card: ${ITSLAM_EFFECTS[card.effect].text}` : CARD_INFO[card.kind]?.text ? `. ${CARD_INFO[card.kind].text}` : '';
  const aria = label ?? name + info;
  const cls = `card ${faceDown ? 'back' : card.kind}${selected ? ' selected' : ''}${small ? ' small' : ''}`;
  const tag = onclick ? 'button' : 'div';
  return h(tag, {
    class: cls, type: onclick ? 'button' : null, 'aria-pressed': onclick ? String(!!selected) : null,
    'aria-label': aria, title: aria, disabled: disabled || null, onclick, 'data-id': card.id, role: onclick ? null : 'img',
  }, h('img', { src: `/cards/${faceDown ? 'back' : card.art}.webp`, alt: '', draggable: 'false', loading: 'lazy', decoding: 'async' }));
}

/** Card category, shown as a text label so type never relies on colour or art alone. */
function typeOf(card) {
  if (!card?.kind) return { cls: '', label: 'Card' };
  if (isHalf(card)) return { cls: 't-sheep', label: 'Sheep' };
  if (isModifier(card)) return { cls: 't-mod', label: 'Modifier' };
  if (card.kind === 'itslam') return { cls: 't-chal', label: 'Challenge' };
  return { cls: 't-act', label: 'Action' };
}
function shortName(card) {
  if (!card?.kind) return 'Face down';
  if (isHalf(card)) return `${colorName(card.color)} ${card.kind === 'head' ? 'Head' : 'Butt'}`;
  if (card.kind === 'itslam') return ITSLAM_EFFECTS[card.effect].name;
  return CARD_INFO[card.kind].name;
}

// Card Types reference (names, counts and lines from the official Print & Play rulebook).
const CARD_TYPES = [
  { title: 'Sheep Cards', sub: 'Play a Head and a Butt of the same colour together.', cls: 't-sheep', label: 'Sheep', cards: [
    ['head-cyan', 'Sheep Head', '×16 colours'], ['butt-cyan', 'Sheep Butt', '×16 colours'], ['butt-rainbow-2', 'Rainbow Head & Butt', '×2 each']] },
  { title: 'Modifier Cards', sub: 'Painted Sheep & FrankenSheep.', cls: 't-mod', label: 'Modifier', cards: [
    ['paint', 'Paint', '×2'], ['franken', 'Franken', '×2']] },
  { title: 'Action Cards', sub: 'Discard all Action Cards once used.', cls: 't-act', label: 'Action', cards: [
    ['yoink', 'Yoink!', '×2'], ['wheat', 'Wheat', '×3'], ['wolf', 'Wolf', '×2'], ['reflip', 'Re-Flip', '×2']] },
  { title: 'Challenge Cards', sub: 'Only 1 Challenge Card can be played per turn.', cls: 't-chal', label: 'Challenge', cards: [
    ['itslam-lure2', 'Lure 2 Sheep', '×1'], ['itslam-remove2', 'Remove 2 Sheep', '×1'], ['itslam-halve2', 'Halve 2 Sheep', '×1'],
    ['itslam-yoinkHand', 'Yoink Entire Hand', '×1'], ['itslam-recover1', 'Recover 1 Sheep', '×1']] },
];

function cardTypesSection(titleId) {
  return h('section', { class: 'types', 'aria-labelledby': titleId },
    h('div', { class: 'types-head' }, h('h2', { id: titleId }, 'Card Types'), h('p', {}, '54 Game Cards · 1 Sheep Coin Token')),
    h('div', { class: 'groups' }, CARD_TYPES.map((g) => h('div', { class: 'group' },
      h('div', {}, h('h3', {}, g.title), h('p', { class: 'gsub' }, g.sub)),
      h('div', { class: 'group-cards', role: 'list' }, g.cards.map(([art, name, count]) => h('div', { class: 'tcell', role: 'listitem' },
        h('div', { class: 'card', role: 'img', 'aria-label': `${name} card` }, h('img', { src: `/cards/${art}.webp`, alt: '', loading: 'lazy' })),
        h('span', { class: `chip ${g.cls}` }, g.label),
        h('span', { class: 'name' }, name),
        h('span', { class: 'count' }, count))))))));
}

// ---------- derived ----------
const myPlayer = () => S.game?.players.find((p) => p.id === S.you);
const playerName = (id) => S.game?.players.find((p) => p.id === id)?.name ?? S.room?.members.find((m) => m.id === id)?.name ?? '?';
const secondsLeft = () => (S.room?.deadline ? Math.max(0, Math.ceil((S.room.deadline - (Date.now() + S.skew)) / 1000)) : null);

// ---------- render ----------
function render() {
  setConn();
  const focusId = document.activeElement?.id;
  app.replaceChildren(!S.room ? homeView() : S.room.status === 'lobby' ? lobbyView() : gameView());
  if (focusId) document.getElementById(focusId)?.focus();
}
setInterval(() => {
  const t = document.getElementById('timer');
  if (t) { const s = secondsLeft(); t.textContent = s == null ? '' : `⏱ ${s}s`; t.classList.toggle('urgent', s != null && s <= 3); }
  const a = document.getElementById('autostart');
  if (a && S.room?.autoStartAt) a.textContent = `Starting automatically in ${Math.max(0, Math.ceil((S.room.autoStartAt - Date.now() - S.skew) / 1000))}s`;
}, 500);

function homeView() {
  const nameInput = h('input', { id: 'name', maxlength: '16', autocomplete: 'nickname', value: savedName(), placeholder: 'e.g. Woolly', required: true });
  const codeInput = h('input', { id: 'code', maxlength: '5', autocapitalize: 'characters', autocomplete: 'off', placeholder: 'ABCDE', value: S.prefillCode ?? '' });
  const getName = () => {
    const n = nameInput.value.trim();
    if (!n) { toast('Pick a name first.'); nameInput.focus(); return null; }
    try { localStorage.setItem(NAME_KEY, n); } catch {}
    return n;
  };
  const go = async (event, extra) => {
    const name = getName(); if (!name) return;
    const res = await emit(event, { name, ...extra });
    if (res.ok) saveCreds({ code: res.code, playerId: res.playerId, secret: res.secret });
  };
  const off = !S.connected || null;
  return h('div', { class: 'home' },
    h('section', { class: 'hero', 'aria-label': 'Play' },
      h('div', {},
        h('h1', {}, h('img', { class: 'wordmark', src: '/brand/wordmark.png', alt: 'Is That Sheep Looking At Me?', width: '448', height: '351' })),
        h('p', { class: 'tagline' }, 'Build a mighty flock of sheep using Sheep Head and Sheep Butt Cards. But be careful, as your sheep can get stolen or discarded by other players!'),
        h('ul', { class: 'meta', 'aria-label': 'Game details' }, h('li', {}, '2–4 Players'), h('li', {}, '10–20 mins'), h('li', {}, 'Ages 8+')),
        h('div', { class: 'name-field' }, h('label', { for: 'name' }, 'Your name'), nameInput),
        S.prefillCode && h('div', { class: 'invite' },
          h('p', {}, 'You were invited to room ', h('b', {}, S.prefillCode), '.'),
          h('button', { class: 'btn primary', type: 'button', disabled: off, onclick: () => go('room:join', { code: S.prefillCode }) }, `Join room ${S.prefillCode}`)),
        h('div', { class: 'cta' },
          h('button', { class: 'btn primary', type: 'button', disabled: off, onclick: () => go('match:quick') }, 'Quick match'),
          h('button', { class: 'btn', type: 'button', disabled: off, onclick: () => go('room:create', { isPublic: false }) }, 'Private room'),
          h('form', { class: 'joincode', onsubmit: (e) => { e.preventDefault(); const c = codeInput.value.trim().toUpperCase(); if (!/^[A-Z0-9]{5}$/.test(c)) return toast('Room codes are 5 letters/numbers.'); go('room:join', { code: c }); } },
            h('label', { for: 'code' }, 'Have a room code?'), codeInput,
            h('button', { class: 'btn dark', type: 'submit', disabled: off }, 'Join'))),
        !S.connected && h('p', { class: 'notice', style: 'margin-top:1rem' }, 'Connecting to the game server… if the site was idle this can take up to a minute.')),
      h('figure', { class: 'hero-art' },
        h('div', { class: 'hero-pair' },
          h('img', { src: '/brand/hero-head.webp', alt: 'Rainbow Head card', width: '498', height: '718' }),
          h('img', { src: '/brand/hero-butt.webp', alt: 'Rainbow Butt card', width: '498', height: '718' })),
        h('figcaption', {}, h('span', { class: 'chip t-sheep' }, 'Sheep'), 'Full Rainbow Sheep', h('span', { class: 'pts' }, '· 2 points')))),
    h('p', { class: 'fine', style: 'margin:.8rem 0 0' }, 'Quick match puts you in a public lobby; it starts 30s after a second player joins (or right away at 4). Private rooms are invite-only — share the code or link.'),
    cardTypesSection('cards-title'),
    h('p', { class: 'fine center home-foot' }, 'Unofficial fan-made version. Game and card artwork by Zedaph & DotDotDash / CREO Cards (from the official Print & Play).'));
}

function leaveButton() {
  return h('button', {
    class: `btn ghost small${S.leaveArm ? ' warn' : ''}`, type: 'button',
    onclick: async () => {
      if (!S.leaveArm && S.room?.status === 'playing') { S.leaveArm = true; render(); setTimeout(() => { S.leaveArm = false; render(); }, 4000); return; }
      S.leaveArm = false;
      await emit('room:leave');
      saveCreds(null); S.room = null; S.game = null; S.prefillCode = null;
      history.replaceState(null, '', '/');
      render();
    },
  }, S.leaveArm ? 'Tap again to forfeit' : 'Leave');
}

function lobbyView() {
  const r = S.room;
  const link = `${location.origin}/r/${r.code}`;
  const isHost = r.hostId === S.you;
  const connectedCount = r.members.filter((m) => m.connected).length;
  return h('section', { class: 'lobby panel' },
    h('div', { class: 'row spread' }, h('h2', {}, r.isPublic ? 'Public lobby' : 'Private room'), leaveButton()),
    h('div', { class: 'code-box' },
      h('div', {}, h('div', { class: 'fine' }, 'Room code'), h('div', { class: 'code', 'aria-label': `Room code ${r.code.split('').join(' ')}` }, r.code)),
      h('div', { class: 'col' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Invite link copied!'); } catch { toast(link); } } }, '📋 Copy invite link'),
        navigator.share && h('button', { class: 'btn small ghost', type: 'button', onclick: () => navigator.share({ title: 'Join my sheep game', url: link }).catch(() => {}) }, 'Share…'))),
    h('h3', {}, `Players (${r.members.length}/4)`),
    h('ul', { class: 'members' }, r.members.map((m) => h('li', {},
      h('span', { class: `dot ${m.connected ? 'on' : 'off'}`, 'aria-hidden': 'true' }), m.name,
      m.id === r.hostId && h('span', { class: 'tag' }, 'host'), m.id === S.you && h('span', { class: 'tag you' }, 'you'),
      !m.connected && h('span', { class: 'fine' }, ' (reconnecting…)')))),
    r.members.length < 2 && h('p', { class: 'notice' }, r.isPublic ? 'Waiting for another shepherd to join…' : 'Share the code or link with 1–3 friends.'),
    r.autoStartAt && h('p', { id: 'autostart', class: 'notice' }, 'Starting soon…'),
    isHost
      ? h('button', { class: 'btn primary big', type: 'button', disabled: connectedCount < 2 || null, onclick: () => emit('room:start') }, connectedCount < 2 ? 'Need 2+ players to start' : `Start game with ${connectedCount}`)
      : h('p', { class: 'fine' }, 'Waiting for the host to start the game.'));
}

// ---------- game view ----------
// Seats around the table, in clockwise order starting with you at the bottom.
const SEATS = { 2: ['bottom', 'top'], 3: ['bottom', 'left', 'right'], 4: ['bottom', 'left', 'top', 'right'] };
const SEAT_NAME = { bottom: 'bottom', left: 'left', top: 'top', right: 'right' };
const POINT_DEG = { top: 0, right: 90, bottom: 180, left: 270 };

function gameView() {
  const g = S.game;
  if (!g) return h('p', { class: 'loading' }, 'Loading game…');
  if (g.phase === 'ended') return endView();
  const me = myPlayer();
  const order = rotate(g.players, S.you); // clockwise, you first
  const posList = SEATS[order.length] ?? SEATS[4];
  const seatOf = new Map(order.map((p, i) => [p.id, posList[i]]));
  const nextId = nextPlayerId(g);
  const open = ['top', 'left', 'right', 'bottom'].filter((pos) => !posList.includes(pos));
  return h('section', { class: 'game' },
    h('div', { class: 'gamebar' },
      h('span', { class: 'pill' }, `Room ${S.room.code}`),
      h('span', { class: 'pill', title: 'Turns pass clockwise around the table' }, '↻ Clockwise'),
      g.finalRound && h('span', { class: 'pill warn' }, '⚠ Final round'),
      h('span', { id: 'timer', class: `pill${(secondsLeft() ?? 99) <= 3 ? ' urgent' : ''}`, 'aria-label': 'Time left for the current decision' }, secondsLeft() == null ? '' : `⏱ ${secondsLeft()}s`),
      h('span', { class: 'spacer' }), leaveButton()),
    h('div', { class: 'table', role: 'region', 'aria-label': 'Card table, turns pass clockwise' },
      order.map((p) => seatEl(p, seatOf.get(p.id), nextId)),
      open.map((pos) => h('div', { class: `seat seat-${pos} open`, 'aria-hidden': 'true' }, h('span', {}, 'Open seat'))),
      tableCenter(g, seatOf)),
    handPanel(me),
    logPanel());
}

/** The next player clockwise from whoever is playing now. */
function nextPlayerId(g) {
  const n = g.players.length;
  let i = g.players.findIndex((p) => p.id === g.turnPlayerId);
  for (let k = 0; k < n; k++) { i = (i + 1) % n; if (!g.players[i].left) return g.players[i].id; }
  return null;
}

function seatEl(p, pos, nextId) {
  const g = S.game;
  const m = S.room.members.find((x) => x.id === p.id);
  const mine = p.id === S.you;
  const isTurn = g.turnPlayerId === p.id;
  const label = `${mine ? 'You' : p.name}, ${SEAT_NAME[pos]} seat${isTurn ? ', playing now' : ''}`;
  return h('section', { class: `seat seat-${pos}${isTurn ? ' turn' : ''}${p.left ? ' gone' : ''}${mine ? ' me' : ''}`, 'aria-label': label },
    h('div', { class: 'seat-head' },
      h('span', { class: `dot ${(m?.connected && !p.left) ? 'on' : 'off'}`, 'aria-hidden': 'true' }),
      h('b', { class: 'seat-name' }, mine ? `${p.name} (you)` : p.name),
      p.left && h('span', { class: 'tag' }, 'left'),
      isTurn && h('span', { class: 'tag turn' }, mine ? 'Your turn' : 'Playing'),
      !isTurn && nextId === p.id && h('span', { class: 'tag next' }, 'Up next'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'stat', title: 'Sheep in field' }, `${p.field.length} sheep`),
      h('span', { class: 'stat', title: 'Cards in hand' }, `✋ ${p.handCount}`),
      h('span', { class: 'score' }, `${p.score} pt${p.score === 1 ? '' : 's'}`)),
    protections(p),
    fieldEl(p));
}

function tableCenter(g, seatOf) {
  const turnPos = seatOf.get(g.turnPlayerId) ?? 'bottom';
  const top = g.discard.at(-1);
  return h('div', { class: 'table-center' },
    h('div', { class: 'piles' },
      h('div', { class: 'pile' },
        h('div', { class: 'card small', role: 'img', 'aria-label': `Draw pile, ${g.deckCount} cards` }, g.deckCount ? h('img', { src: '/cards/back.webp', alt: '' }) : null),
        h('span', { class: 'pile-label' }, `Draw · ${g.deckCount}`)),
      h('div', { class: 'turn-pointer', 'aria-hidden': 'true' },
        h('span', { class: 'arrow', style: `transform: rotate(${POINT_DEG[turnPos]}deg)`, html: '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5"/><path d="M5 11l7-7 7 7"/></svg>' })),
      h('button', { class: 'pile pilebtn', type: 'button', onclick: () => openDiscard(), 'aria-label': `Discard pile, ${g.discard.length} cards. Open to view` },
        top ? cardEl(top, { small: true, label: 'Top of the discard pile' }) : h('div', { class: 'card small emptypile' }),
        h('span', { class: 'pile-label' }, `Discard · ${g.discard.length}`))),
    statusBanner(),
    g.pending && pendingPanel());
}

function rotate(players, youId) {
  const i = players.findIndex((p) => p.id === youId);
  return i < 0 ? players : [...players.slice(i), ...players.slice(0, i)];
}

function statusBanner() {
  const g = S.game;
  const mine = g.waitingOn === S.you;
  let text;
  const pd = g.pending;
  if (pd) {
    const who = playerName(g.waitingOn);
    if (pd.stage === 'guess') text = mine ? 'Make your guess: is the sheep looking at you?' : `${who} is guessing the coin…`;
    else if (pd.stage === 'reflip') text = mine ? 'You hold a Re-flip. Play it to force a new guess and a new flip?' : 'Waiting to see if anyone plays a Re-flip…';
    else text = mine ? 'You won the flip! Choose the effect\'s targets.' : `${who} is choosing the effect…`;
  } else {
    text = mine ? (S.discardMode ? 'Too many cards. Choose cards to discard.' : 'Your turn! Play cards, then press Baa! to end your turn.') : `${playerName(g.turnPlayerId)}'s turn`;
  }
  const off = S.room.members.find((m) => m.id === g.waitingOn && !m.connected);
  return h('div', { class: `status${mine ? ' mine' : ''}`, role: 'status', 'aria-live': 'polite' },
    h('strong', {}, text),
    off && h('span', { class: 'fine' }, ` (${off.name} is disconnected; their turn will be played automatically if they don't return)`));
}

function protections(p) {
  return h('div', { class: 'prot' },
    p.wolfProtected && h('span', { class: 'tag', title: 'Double-headed frankensheep: immune to Wolf cards' }, '🛡 Wolf-proof'),
    p.wheatProtected && h('span', { class: 'tag', title: 'Double-butted frankensheep: immune to Wheat cards' }, '🛡 Wheat-proof'));
}

function fieldEl(p) {
  if (!p.field.length) return h('div', { class: 'field empty' }, h('span', { class: 'fine' }, 'No sheep yet'));
  return h('div', { class: 'field' }, p.field.map((s) => sheepEl(p, s)));
}

function sheepEl(owner, s) {
  const g = S.game;
  const pd = g.pending;
  const effectMode = pd?.stage === 'effect' && pd.winnerId === S.you && owner.id === pd.loserId;
  const picked = effectMode && (S.effectSel.includes(s.id) || S.halves.has(s.id));
  const targetable = isSheepTargetable(owner, s);
  const desc = `${owner.id === S.you ? 'Your' : owner.name + "'s"} sheep: ${s.cards.map(cardLabel).join(' and ')}${s.modifier ? ` with ${cardLabel(s.modifier)}` : ''}${isFullRainbow(s) ? ' (full rainbow, 2 points)' : ''}`;
  const fresh = S.fresh.has(s.id);
  return h('div', { class: `sheep${picked ? ' picked' : ''}${targetable ? ' targetable' : ''}${isFullRainbow(s) ? ' rainbow' : ''}${fresh ? ' fresh' : ''}`, role: 'group', 'aria-label': desc + (fresh ? ' (new)' : '') },
    fresh && h('span', { class: 'newtag' }, 'New'),
    s.modifier && h('div', { class: 'mod' }, h('img', { src: `/cards/${s.modifier.art}.webp`, alt: `${MOD_ICON[s.modifier.kind]} modifier` })),
    h('div', { class: 'halves' }, s.cards.map((c) => cardEl(c, {
      small: true,
      selected: S.halves.get(s.id) === c.id,
      onclick: targetable ? () => onSheepClick(owner, s, c) : null,
      label: targetable ? `${desc}. Target ${cardLabel(c)}` : undefined,
    }))),
    isFullRainbow(s) && h('div', { class: 'pts' }, '+2'));
}

function selectedHand() {
  const me = myPlayer();
  return [...S.sel].map((id) => me.hand.find((c) => c.id === id)).filter(Boolean);
}

function isSheepTargetable(owner, s) {
  const g = S.game; const pd = g.pending;
  if (pd) return pd.stage === 'effect' && pd.winnerId === S.you && owner.id === pd.loserId && ['lure2', 'remove2', 'halve2'].includes(pd.effect);
  if (g.turnPlayerId !== S.you || S.discardMode) return false;
  const sel = selectedHand();
  if (sel.length !== 1) return false;
  const c = sel[0];
  if (isHalf(c)) return s.cards.some((_, i) => canBodyswap(s, i, c));
  if (c.kind === 'wheat') return !owner.left && !owner.wheatProtected;
  if (c.kind === 'wolf') return !owner.left && !owner.wolfProtected;
  return false;
}

function onSheepClick(owner, s, half) {
  const g = S.game; const pd = g.pending;
  if (pd) {
    const need = pd.options?.pick ?? 0;
    if (pd.effect === 'halve2') {
      if (S.halves.get(s.id) === half.id) S.halves.delete(s.id);
      else if (S.halves.has(s.id) || S.halves.size < need) S.halves.set(s.id, half.id);
      else toast(`You can only pick ${need} sheep.`);
    } else {
      const i = S.effectSel.indexOf(s.id);
      if (i >= 0) S.effectSel.splice(i, 1);
      else if (S.effectSel.length < need) S.effectSel.push(s.id);
      else toast(`You can only pick ${need} sheep.`);
    }
    return render();
  }
  const c = selectedHand()[0];
  if (isHalf(c)) {
    const i = s.cards.findIndex((x) => x.id === half.id);
    if (!isBodyswappable(s)) return toast('Only Modified (Paint/Franken) or Half Rainbow sheep can be bodyswapped.');
    if (!canBodyswap(s, i, c)) return toast(`Swapping in the ${cardLabel(c)} there wouldn't leave a Basic or Full Rainbow sheep. Try the other half.`);
    return act({ type: 'bodyswap', ownerId: owner.id, sheepId: s.id, replaceCardId: half.id, handCardId: c.id });
  }
  if (c.kind === 'wheat' || c.kind === 'wolf') return act({ type: c.kind, cardId: c.id, targetId: owner.id, sheepId: s.id });
}

function handPanel(me) {
  const g = S.game;
  const myTurn = g.turnPlayerId === S.you && !g.pending;
  const canPick = myTurn;
  const toggle = (c) => {
    if (S.discardMode && c.kind === 'itslam') return toast('"Is That Sheep Looking At Me?" cards can\'t be discarded.');
    S.sel.has(c.id) ? S.sel.delete(c.id) : S.sel.add(c.id);
    render();
  };
  const hand = [...me.hand].sort(handSort);
  return h('div', { class: 'handwrap' },
    h('div', { class: 'row spread' }, h('h2', {}, `Your hand (${me.hand.length})`), me.hand.length > HAND_MAX && h('span', { class: 'tag warn' }, `over ${HAND_MAX}`)),
    myTurn && actionBar(me),
    h('div', { class: 'hand', role: 'list' }, hand.length ? hand.map((c) => h('div', { role: 'listitem', class: 'hcell' }, cardEl(c, {
      selected: S.sel.has(c.id), onclick: canPick ? () => toggle(c) : null,
      disabled: S.discardMode && c.kind === 'itslam',
    }), h('span', { class: `chip ${typeOf(c).cls}` }, typeOf(c).label), h('span', { class: 'hname' }, shortName(c)))) : h('p', { class: 'fine' }, 'Your hand is empty.')));
}
const ORDER = ['head', 'butt', 'paint', 'franken', 'wheat', 'wolf', 'yoink', 'reflip', 'itslam'];
function handSort(a, b) {
  return ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || String(a.color ?? a.effect ?? '').localeCompare(String(b.color ?? b.effect ?? ''));
}

function actionBar(me) {
  const g = S.game;
  const sel = selectedHand();
  const opps = g.players.filter((p) => p.id !== S.you && !p.left);
  const bar = [];
  let hint = 'Select cards in your hand to play them.';

  if (S.discardMode) {
    const need = me.hand.length - HAND_MAX;
    hint = `Select ${need} card${need > 1 ? 's' : ''} to discard (${sel.length} selected).`;
    bar.push(h('button', { class: 'btn primary', type: 'button', disabled: sel.length !== need || null, onclick: () => act({ type: 'endTurn', discardIds: sel.map((c) => c.id) }) }, `Discard & Baa!`));
    bar.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.discardMode = false; S.sel.clear(); render(); } }, 'Back'));
  } else {
    const halves = sel.filter(isHalf); const mods = sel.filter(isModifier);
    if (sel.length >= 2 && halves.length === 2 && mods.length <= 1 && sel.length === halves.length + mods.length) {
      const ok = isValidSheep(halves[0], halves[1], mods[0] ?? null);
      hint = ok ? 'Ready to make a sheep!' : (halves[0].kind === halves[1].kind ? 'Two heads or two butts need a Franken modifier.' : 'Those colours don\'t match. Use a rainbow half or a Paint modifier.');
      bar.push(h('button', { class: 'btn primary', type: 'button', disabled: !ok || null, onclick: () => act({ type: 'makeSheep', cardIds: halves.map((c) => c.id), modifierId: mods[0]?.id }) }, '🐑 Make sheep'));
    } else if (sel.length === 1) {
      const c = sel[0];
      if (isHalf(c)) hint = 'Pick another half (and optionally a modifier) to make a sheep, or tap a highlighted half of a Modified or Half Rainbow sheep in any field to bodyswap.';
      else if (isModifier(c)) hint = c.kind === 'paint' ? 'Paint: also select one head and one butt.' : 'Franken: also select two heads or two butts.';
      else if (c.kind === 'wheat') hint = 'Wheat: tap any sheep (in any field you choose) to lure it into your field.';
      else if (c.kind === 'wolf') hint = 'Wolf: tap any sheep (in any field you choose) to send it to the discard pile.';
      else if (c.kind === 'reflip') hint = 'Re-flip: after any coin flip you\'ll be asked whether to play it, even if the flip doesn\'t affect you.';
      else if (c.kind === 'yoink') {
        hint = 'Yoink!: choose who to steal 2 random cards from.';
        for (const o of opps) bar.push(h('button', { class: 'btn', type: 'button', disabled: !o.handCount || null, onclick: () => act({ type: 'yoink', cardId: c.id, targetId: o.id }) }, `Yoink ${o.name} (${o.handCount})`));
      } else if (c.kind === 'itslam') {
        hint = g.itslamPlayedThisTurn ? 'You already played one of these this turn.' : `${ITSLAM_EFFECTS[c.effect].name}: ${ITSLAM_EFFECTS[c.effect].text} Choose an opponent.`;
        for (const o of opps) bar.push(h('button', { class: 'btn danger', type: 'button', disabled: g.itslamPlayedThisTurn || null, onclick: () => act({ type: 'itslam', cardId: c.id, targetId: o.id }) }, `👀 at ${o.name}`));
      }
    } else if (sel.length > 1) hint = 'To make a sheep select exactly 2 halves (+ optional Paint/Franken). Other cards are played one at a time.';
    if (sel.length) bar.push(h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.sel.clear(); render(); } }, 'Clear'));
    bar.push(h('button', {
      class: 'btn baa', type: 'button', id: 'btn-baa',
      onclick: () => {
        if (me.hand.length > HAND_MAX) { S.discardMode = true; S.sel.clear(); render(); return; }
        act({ type: 'endTurn', discardIds: [] });
      },
    }, me.hand.length > HAND_MAX ? `Baa! (discard ${me.hand.length - HAND_MAX} first)` : '🐑 Baa! End turn'));
  }
  return h('div', { class: 'actionbar' }, h('p', { class: 'hint' }, hint), h('div', { class: 'buttons' }, bar));
}

function coinEl(looking) {
  return h('div', { class: `coin${looking == null ? ' spin' : ''}`, role: 'img', 'aria-label': looking == null ? 'Sheep coin, not flipped yet' : looking ? 'The sheep IS looking at you' : 'The sheep is NOT looking at you' },
    looking == null ? '🪙' : looking ? '👀' : '🍑');
}

function pendingPanel() {
  const g = S.game; const pd = g.pending; const me = myPlayer();
  const att = playerName(pd.attackerId); const def = playerName(pd.defenderId);
  const eff = ITSLAM_EFFECTS[pd.effect];
  const kids = [h('h2', {}, `👀 ${att} played “${eff.name}” at ${def}`), h('p', { class: 'fine' }, eff.text)];
  if (pd.stage === 'guess') {
    kids.push(coinEl(null));
    if (pd.attackerId === S.you) {
      kids.push(h('p', {}, pd.flips ? 'Re-flip! Guess again:' : 'Is the sheep coin looking at you?'),
        h('div', { class: 'buttons' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => act({ type: 'guess', looking: true }) }, '👀 It IS looking at me'),
          h('button', { class: 'btn', type: 'button', onclick: () => act({ type: 'guess', looking: false }) }, '🍑 It is NOT looking at me')));
    } else kids.push(h('p', {}, `${att} is guessing…`));
  } else {
    kids.push(coinEl(pd.coin),
      h('p', {}, `${att} guessed “${pd.guess ? 'looking' : 'not looking'}”. The sheep ${pd.coin ? 'IS' : 'is NOT'} looking. `, h('b', {}, `${playerName(pd.winnerId)} wins the flip!`)));
    if (pd.stage === 'reflip') {
      if (pd.reflipAsk === S.you) {
        const rf = me.hand.find((c) => c.kind === 'reflip');
        kids.push(h('div', { class: 'buttons' },
          rf && h('button', { class: 'btn primary', type: 'button', onclick: () => act({ type: 'reflip', cardId: rf.id }) }, '🪙 Play Re-flip'),
          h('button', { class: 'btn', type: 'button', onclick: () => act({ type: 'acceptFlip' }) }, 'Let it stand')));
      } else kids.push(h('p', {}, 'Anyone holding a Re-flip may play it…'));
    } else if (pd.stage === 'effect') {
      if (pd.winnerId === S.you) kids.push(effectChooser());
      else kids.push(h('p', {}, `${playerName(pd.winnerId)} is choosing…`));
    }
  }
  return h('div', { class: 'pending panel', role: 'region', 'aria-label': 'Coin flip' }, kids);
}

function effectChooser() {
  const g = S.game; const pd = g.pending; const need = pd.options?.pick ?? 0;
  const loser = playerName(pd.loserId);
  if (pd.effect === 'lure2' || pd.effect === 'remove2') {
    return h('div', {},
      h('p', {}, `Tap ${need} of ${loser}'s sheep (highlighted above) to ${pd.effect === 'lure2' ? 'lure into your field' : 'remove'}. ${S.effectSel.length}/${need} chosen.`),
      h('button', { class: 'btn primary', type: 'button', disabled: S.effectSel.length !== need || null, onclick: () => act({ type: 'effectChoice', sheepIds: S.effectSel }) }, 'Confirm'));
  }
  if (pd.effect === 'halve2') {
    return h('div', {},
      h('p', {}, `Tap the head or butt you want from ${need} of ${loser}'s sheep. You also take any modifier. ${S.halves.size}/${need} chosen.`),
      h('button', { class: 'btn primary', type: 'button', disabled: S.halves.size !== need || null, onclick: () => act({ type: 'effectChoice', halves: [...S.halves].map(([sheepId, cardId]) => ({ sheepId, cardId })) }) }, 'Confirm'));
  }
  if (pd.effect === 'recover1') {
    const sel = S.recoverSel.map((id) => g.discard.find((c) => c.id === id)).filter(Boolean);
    const halves = sel.filter(isHalf); const mods = sel.filter(isModifier);
    const ok = halves.length === 2 && mods.length <= 1 && isValidSheep(halves[0], halves[1], mods[0] ?? null);
    const usable = g.discard.filter((c) => isHalf(c) || isModifier(c)); // includes face-down cards: the winner goes through the whole pile
    return h('div', {},
      h('p', {}, 'Pick 2 halves (plus an optional Paint/Franken) from the discard pile to make a sheep in your field.'),
      h('div', { class: 'hand discardpick' }, usable.map((c) => cardEl(c, {
        small: true, selected: S.recoverSel.includes(c.id),
        onclick: () => { const i = S.recoverSel.indexOf(c.id); i >= 0 ? S.recoverSel.splice(i, 1) : S.recoverSel.push(c.id); render(); },
      }))),
      h('button', { class: 'btn primary', type: 'button', disabled: !ok || null, onclick: () => act({ type: 'effectChoice', recover: { cardIds: halves.map((c) => c.id), modifierId: mods[0]?.id } }) }, 'Recover sheep'));
  }
  return h('p', {}, 'Resolving…');
}

function logPanel() {
  const g = S.game;
  return h('details', { class: 'log panel', open: window.matchMedia('(min-width: 900px)').matches || null },
    h('summary', {}, 'Game log'),
    h('ol', { reversed: true }, [...g.log].reverse().slice(0, 25).map((e) => h('li', {}, e.text))));
}

function openDiscard() {
  const g = S.game;
  const d = h('dialog', { 'aria-label': 'Discard pile' },
    h('form', { method: 'dialog', class: 'dialog-close' }, h('button', { class: 'btn ghost small', 'aria-label': 'Close' }, '✕')),
    h('h2', {}, `Discard pile (${g.discard.length})`),
    g.discard.length ? h('div', { class: 'hand' }, [...g.discard].reverse().map((c) => cardEl(c, { small: true }))) : h('p', {}, 'Empty.'));
  d.addEventListener('close', () => d.remove());
  document.body.append(d); d.showModal();
}

function endView() {
  const g = S.game; const r = g.result;
  const scores = [...r.scores].sort((a, b) => b.total - a.total);
  const iWon = r.winners.includes(S.you);
  return h('section', { class: 'end panel' },
    h('h1', {}, iWon ? '🏆 You win! Baa!' : `🏁 ${playerName(r.winners[0])} wins!`),
    h('p', { class: 'fine' }, r.reason),
    r.tiedIds?.length > 1 && h('p', { class: 'notice' }, `Tie between ${r.tiedIds.map(playerName).join(' & ')}! The sheep coin was flipped and picked ${playerName(r.winners[0])}.`),
    h('table', { class: 'scores' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Player'), h('th', {}, 'Sheep'), h('th', {}, 'Sheep pts'), h('th', {}, 'ITSLAM held'), h('th', {}, 'Total'))),
      h('tbody', {}, scores.map((s) => h('tr', { class: r.winners.includes(s.id) ? 'win' : '' },
        h('td', {}, s.name, s.left ? ' (left)' : '', s.id === S.you ? ' (you)' : ''), h('td', {}, s.sheepCount), h('td', {}, s.sheep), h('td', {}, s.itslamInHand ? `${s.itslamInHand} (−${s.penalty})` : '0'), h('td', {}, h('b', {}, s.total)))))),
    h('div', { class: 'buttons' },
      S.room.hostId === S.you
        ? h('button', { class: 'btn primary', type: 'button', onclick: () => emit('room:rematch') }, '🔁 Rematch with everyone here')
        : h('p', { class: 'fine' }, 'The host can start a rematch.'),
      leaveButton()),
    logPanel());
}

render();
