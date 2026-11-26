import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomManager, config } from './rooms.js';
import { RuleError } from './engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ROOMS_PER_IP = Number(process.env.MAX_ROOMS_PER_IP ?? 6);

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:" + (ALLOWED_ORIGINS.length ? ' ' + ALLOWED_ORIGINS.join(' ') : '') + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });
  // RENDER_GIT_COMMIT is set by Render on each deploy: lets you confirm which build is live.
  app.get('/healthz', (_req, res) => res.json({ ok: true, version: (process.env.RENDER_GIT_COMMIT ?? 'dev').slice(0, 7), turnSeconds: config.turnMs / 1000, ...manager.stats() }));
  // Code and pages are revalidated on every load (cheap 304s via ETag) so a redeploy reaches players at once;
  // card art, fonts and images rarely change and are cached for a day.
  const cacheHeaders = (res, file) => res.set('Cache-Control', /\.(html|js|css|json)$/.test(file) ? 'no-cache' : 'public, max-age=86400');
  app.use('/shared', express.static(path.join(root, 'shared'), { setHeaders: cacheHeaders }));
  app.use(express.static(path.join(root, 'public'), { extensions: ['html'], setHeaders: cacheHeaders }));
  // Room links like /r/ABCDE serve the app; the client reads the code from the URL.
  app.get('/r/:code', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(root, 'public', 'index.html')));

  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    cors: ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS } : undefined,
    connectionStateRecovery: { maxDisconnectionDuration: 0 },
  });
  const manager = new RoomManager(io);
  const roomsByIp = new Map();

  io.on('connection', (socket) => {
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;
    // Token bucket: 12 events/sec burst 30.
    let tokens = 30; let last = Date.now();
    const allow = () => {
      const now = Date.now();
      tokens = Math.min(30, tokens + ((now - last) / 1000) * 12); last = now;
      if (tokens < 1) return false;
      tokens -= 1; return true;
    };
    let joinAttempts = 0;

    const handle = (event, fn) => socket.on(event, async (payload, ack) => {
      if (typeof ack !== 'function') ack = () => {};
      if (!allow()) return ack({ error: 'Slow down a little!' });
      try {
        ack({ ok: true, ...(await fn(payload && typeof payload === 'object' ? payload : {})) });
      } catch (e) {
        if (e instanceof RuleError) ack({ error: e.message });
        else { console.error(event, e); ack({ error: 'Something went wrong on the server.' }); }
      }
    });

    const current = () => {
      const room = manager.get(socket.data.room);
      const member = room?.members.find((m) => m.id === socket.data.playerId);
      if (!room || !member) throw new RuleError('You are not in a room.');
      return { room, member };
    };
    const creds = (room, member) => ({ code: room.code, playerId: member.id, secret: member.secret });
    const leaveCurrent = () => {
      const room = manager.get(socket.data.room);
      const member = room?.members.find((m) => m.id === socket.data.playerId);
      if (room && member) { socket.leave(room.code); manager.leave(room, member); }
      socket.data.room = null; socket.data.playerId = null;
    };
    const limitIp = () => {
      const n = [...manager.rooms.values()].filter((r) => r.creatorIp === ip && r.status !== 'ended').length;
      if (n >= MAX_ROOMS_PER_IP) throw new RuleError('Too many open rooms from your network. Finish or leave one first.');
    };

    handle('room:create', ({ name, isPublic }) => {
      limitIp();
      leaveCurrent();
      const { room, member } = manager.create({ name, isPublic });
      room.creatorIp = ip;
      manager.attach(room, member, socket);
      return creds(room, member);
    });

    handle('room:join', ({ code, name }) => {
      if (++joinAttempts > 20) throw new RuleError('Too many join attempts. Refresh the page to try again.');
      if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,8}$/.test(code)) throw new RuleError('Room codes are 5 letters/numbers.');
      const room = manager.get(code);
      if (room && room.members.some((m) => m.id === socket.data.playerId)) return creds(room, current().member);
      leaveCurrent();
      const r = manager.join({ code, name });
      manager.attach(r.room, r.member, socket);
      return creds(r.room, r.member);
    });

    handle('match:quick', ({ name }) => {
      leaveCurrent();
      const r = manager.quickMatch({ name });
      if (!r.room.creatorIp) { limitIp(); r.room.creatorIp = ip; }
      manager.attach(r.room, r.member, socket);
      return creds(r.room, r.member);
    });

    handle('room:resume', ({ code, playerId, secret }) => {
      const room = manager.get(code);
      const member = manager.auth(room, playerId, secret);
      if (!member || member.left) throw new RuleError('That seat is no longer available.');
      manager.attach(room, member, socket);
      return creds(room, member);
    });

    handle('room:leave', () => { leaveCurrent(); return {}; });
    handle('room:start', () => { const { room, member } = current(); manager.start(room, member.id); return {}; });
    handle('room:rematch', () => { const { room, member } = current(); manager.rematch(room, member.id); return {}; });
    handle('game:action', ({ action }) => {
      const { room, member } = current();
      if (!action || typeof action !== 'object' || JSON.stringify(action).length > 2000) throw new RuleError('Bad action.');
      manager.act(room, member, action);
      return {};
    });

    socket.on('disconnect', () => manager.detach(socket));
  });

  return { app, server, io, manager };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createServer();
  server.listen(PORT, () => console.log(`Sheep game server on http://localhost:${PORT}`));
}
