// Room, lobby, matchmaking and timer management. Holds all authoritative state in memory.
import crypto from 'node:crypto';
import {
  createGame, applyAction, autoAct, viewFor, waitingOn, playerLeaves, RuleError, MAX_PLAYERS, MIN_PLAYERS,
} from './engine.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const config = {
  turnMs: Number(process.env.TURN_SECONDS ?? 8) * 1000,
  decisionMs: Number(process.env.DECISION_SECONDS ?? 40) * 1000,
  disconnectedTurnMs: Number(process.env.DISCONNECTED_TURN_SECONDS ?? 25) * 1000,
  dropAfterMs: Number(process.env.DROP_AFTER_SECONDS ?? 180) * 1000,
  lobbyDropMs: 60 * 1000,
  publicAutoStartMs: Number(process.env.PUBLIC_AUTOSTART_SECONDS ?? 30) * 1000,
  roomIdleMs: 30 * 60 * 1000,
  maxRooms: Number(process.env.MAX_ROOMS ?? 500),
};

export const rng = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;
const randomCode = () => Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
const randomId = (n = 9) => crypto.randomBytes(n).toString('base64url');

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s.length ? s : null;
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  // ---------- lookup ----------
  get(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  auth(room, playerId, secret) {
    const m = room?.members.find((x) => x.id === playerId);
    if (!m || typeof secret !== 'string' || secret.length !== m.secret.length) return null;
    return crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(m.secret)) ? m : null;
  }

  // ---------- lifecycle ----------
  create({ name, isPublic }) {
    if (this.rooms.size >= config.maxRooms) throw new RuleError('The server is full right now. Please try again later.');
    let code; do code = randomCode(); while (this.rooms.has(code));
    const room = {
      code, isPublic: !!isPublic, status: 'lobby', members: [], hostId: null, game: null,
      autoStartAt: null, deadline: null, timers: {}, lastActivity: Date.now(), createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    const member = this.addMember(room, name);
    return { room, member };
  }

  addMember(room, name) {
    if (room.status !== 'lobby') throw new RuleError('That game has already started.');
    if (room.members.length >= MAX_PLAYERS) throw new RuleError('That room is full (max 4 players).');
    let n = cleanName(name) ?? 'Shepherd';
    const base = n; let k = 2;
    while (room.members.some((m) => m.name.toLowerCase() === n.toLowerCase())) n = `${base.slice(0, 13)} ${k++}`;
    const member = { id: randomId(6), secret: randomId(18), name: n, connected: false, socketId: null, lastSeen: Date.now() };
    room.members.push(member);
    room.hostId ??= member.id;
    this.touch(room);
    this.scheduleAutoStart(room);
    return member;
  }

  join({ code, name }) {
    const room = this.get(code);
    if (!room) throw new RuleError('No room with that code. Check the code and try again.');
    return { room, member: this.addMember(room, name) };
  }

  quickMatch({ name }) {
    const open = [...this.rooms.values()]
      .filter((r) => r.isPublic && r.status === 'lobby' && r.members.length < MAX_PLAYERS && r.members.some((m) => m.connected))
      .sort((a, b) => b.members.length - a.members.length || a.createdAt - b.createdAt);
    if (open.length) return { room: open[0], member: this.addMember(open[0], name) };
    return this.create({ name, isPublic: true });
  }

  attach(room, member, socket) {
    if (member.socketId && member.socketId !== socket.id) this.io.sockets.sockets.get(member.socketId)?.leave(room.code);
    member.socketId = socket.id;
    member.connected = true;
    member.lastSeen = Date.now();
    socket.join(room.code);
    socket.data.room = room.code;
    socket.data.playerId = member.id;
    this.touch(room);
    if (room.status === 'playing') this.armTimer(room);
    if (room.status === 'lobby') this.scheduleAutoStart(room);
    this.broadcast(room);
  }

  detach(socket) {
    const room = this.get(socket.data.room);
    const member = room?.members.find((m) => m.id === socket.data.playerId);
    if (!member || member.socketId !== socket.id) return;
    member.connected = false;
    member.socketId = null;
    member.lastSeen = Date.now();
    if (room.status === 'playing') this.armTimer(room);
    if (room.status === 'lobby') this.scheduleAutoStart(room);
    this.broadcast(room);
  }

  leave(room, member) {
    if (room.status === 'lobby' || room.status === 'ended') {
      room.members = room.members.filter((m) => m !== member);
      if (room.hostId === member.id) room.hostId = room.members[0]?.id ?? null;
      if (!room.members.length) return this.destroy(room);
      if (room.status === 'lobby') this.scheduleAutoStart(room);
    } else {
      member.left = true;
      playerLeaves(room.game, member.id, rng);
      this.afterGameChange(room);
    }
    this.broadcast(room);
  }

  start(room, byId) {
    if (room.status !== 'lobby') throw new RuleError('The game has already started.');
    if (byId && byId !== room.hostId) throw new RuleError('Only the host can start the game.');
    const players = room.members.filter((m) => m.connected || !byId);
    if (players.length < MIN_PLAYERS) throw new RuleError(`Need at least ${MIN_PLAYERS} connected players to start.`);
    // Drop disconnected lobby members at start.
    room.members = room.members.filter((m) => players.includes(m));
    room.game = createGame(room.members.map((m) => ({ id: m.id, name: m.name })), rng);
    room.status = 'playing';
    room.autoStartAt = null;
    clearTimeout(room.timers.autoStart);
    this.touch(room);
    this.armTimer(room);
    this.broadcast(room);
  }

  rematch(room, byId) {
    if (room.status !== 'ended') throw new RuleError('The game is not over yet.');
    if (byId !== room.hostId) throw new RuleError('Only the host can start a rematch.');
    room.members = room.members.filter((m) => !m.left && m.connected);
    room.hostId = room.members.find((m) => m.id === byId)?.id ?? room.members[0]?.id;
    room.status = 'lobby';
    room.game = null;
    room.deadline = null;
    this.start(room, byId);
  }

  act(room, member, action) {
    if (room.status !== 'playing') throw new RuleError('The game is not in progress.');
    applyAction(room.game, member.id, action, rng);
    this.afterGameChange(room);
    this.broadcast(room);
  }

  afterGameChange(room) {
    this.touch(room);
    if (room.game.phase === 'ended') {
      room.status = 'ended';
      room.deadline = null;
      clearTimeout(room.timers.turn);
    } else {
      this.armTimer(room);
    }
  }

  // ---------- timers ----------
  /** Public lobbies start automatically: soon after 2+ are connected, almost immediately at 4. */
  scheduleAutoStart(room) {
    if (!room.isPublic || room.status !== 'lobby') return;
    const live = room.members.filter((m) => m.connected).length;
    const cancel = () => { clearTimeout(room.timers.autoStart); room.autoStartAt = null; };
    if (live < MIN_PLAYERS) return cancel();
    const delay = live >= MAX_PLAYERS ? 1500 : config.publicAutoStartMs;
    const target = Date.now() + delay;
    if (room.autoStartAt && room.autoStartAt <= target) return; // already counting down
    cancel();
    room.autoStartAt = target;
    room.timers.autoStart = setTimeout(() => this.tryAutoStart(room), delay);
  }

  tryAutoStart(room) {
    if (room.status !== 'lobby' || !this.rooms.has(room.code)) return;
    room.members = room.members.filter((m) => m.connected);
    if (!room.members.some((m) => m.id === room.hostId)) room.hostId = room.members[0]?.id ?? null;
    try { this.start(room, null); } catch { room.autoStartAt = null; this.broadcast(room); }
  }

  /** (Re)arm the deadline for whoever the game is waiting on. */
  armTimer(room) {
    clearTimeout(room.timers.turn);
    const g = room.game;
    if (!g || g.phase !== 'playing') { room.deadline = null; return; }
    const who = waitingOn(g);
    const key = `${g.turnNumber}:${g.seq}:${who}`;
    const m = room.members.find((x) => x.id === who);
    const base = g.pending ? config.decisionMs : config.turnMs;
    if (room.deadlineKey !== key) { room.deadlineKey = key; room.deadline = Date.now() + base; }
    if (m && !m.connected) room.deadline = Math.min(room.deadline, Date.now() + config.disconnectedTurnMs);
    room.timers.turn = setTimeout(() => this.onDeadline(room, key), Math.max(0, room.deadline - Date.now()));
  }

  onDeadline(room, key) {
    const g = room.game;
    if (!g || g.phase !== 'playing' || room.deadlineKey !== key) return;
    const who = room.members.find((x) => x.id === waitingOn(g));
    try {
      if (who && !who.connected && Date.now() - who.lastSeen > config.dropAfterMs) {
        who.left = true;
        playerLeaves(g, who.id, rng);
      } else {
        autoAct(g, rng);
      }
    } catch (e) { console.error('autoAct failed', e); }
    this.afterGameChange(room);
    this.broadcast(room);
  }

  // ---------- output ----------
  roomInfo(room) {
    return {
      code: room.code, isPublic: room.isPublic, status: room.status, hostId: room.hostId,
      autoStartAt: room.autoStartAt, deadline: room.deadline, serverNow: Date.now(),
      members: room.members.map((m) => ({ id: m.id, name: m.name, connected: m.connected, left: !!m.left })),
    };
  }

  broadcast(room) {
    const info = this.roomInfo(room);
    for (const m of room.members) {
      if (!m.socketId) continue;
      this.io.to(m.socketId).emit('state', { room: info, game: room.game ? viewFor(room.game, m.id) : null, you: m.id });
    }
  }

  touch(room) { room.lastActivity = Date.now(); }

  destroy(room) {
    Object.values(room.timers).forEach(clearTimeout);
    this.rooms.delete(room.code);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (room.status === 'lobby') {
        const before = room.members.length;
        room.members = room.members.filter((m) => m.connected || now - m.lastSeen < config.lobbyDropMs);
        if (room.members.length !== before) {
          if (!room.members.some((m) => m.id === room.hostId)) room.hostId = room.members[0]?.id ?? null;
          this.scheduleAutoStart(room);
          this.broadcast(room);
        }
        if (!room.members.length) { this.destroy(room); continue; }
      }
      const anyone = room.members.some((m) => m.connected);
      if (!anyone && now - room.lastActivity > (room.status === 'playing' ? config.roomIdleMs : 10 * 60 * 1000)) this.destroy(room);
    }
  }

  stats() {
    let lobbies = 0; let playing = 0; let waiting = 0;
    for (const r of this.rooms.values()) {
      if (r.status === 'playing') playing++;
      if (r.status === 'lobby') { lobbies++; if (r.isPublic) waiting += r.members.filter((m) => m.connected).length; }
    }
    return { rooms: this.rooms.size, lobbies, playing, publicPlayersWaiting: waiting };
  }
}
