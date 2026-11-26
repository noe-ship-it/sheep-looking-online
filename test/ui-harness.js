// Test-only: runs the real server plus a localhost control port that can rig a room's deal
// for scripted browser tests. Never used in production (`npm start` runs server/index.js).
import http from 'node:http';
import { createServer } from '../server/index.js';

const { server, manager } = createServer();
const PORT = Number(process.env.PORT ?? 3200);
server.listen(PORT, '127.0.0.1', () => console.log(`ui-harness game on ${PORT}, control on ${PORT + 1}`));

let n = 0;
const C = (kind, color, extra = {}) => ({
  id: `r${++n}`, kind, ...(color ? { color } : {}), ...extra,
  art: color ? `${kind}-${color === 'rainbow' ? 'rainbow-1' : color}` : kind === 'itslam' ? `itslam-${extra.effect}` : kind,
});

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const room = manager.get(url.searchParams.get('code'));
  if (!room?.game) { res.writeHead(404); return res.end('no game'); }
  const g = room.game;
  if (url.pathname === '/rig4') {
    const cols = [['orange', 'pink'], ['cyan'], ['purple', 'lime', 'blue', 'yellow', 'white', 'black', 'beige'], ['brown']];
    g.players.forEach((p, i) => {
      p.field = (cols[i] ?? []).map((c, k) => ({ id: `s9${i}${k}`, cards: [C('head', c), C('butt', c)], modifier: null }));
      if (i === 2) { p.field[1] = { id: 's9mod', cards: [C('head', 'lime'), C('butt', 'green')], modifier: C('paint') }; p.field[6] = { id: 's9rb', cards: [C('head', 'rainbow'), C('butt', 'rainbow')], modifier: null }; }
      p.hand = [C('head', 'grey'), C('wheat')];
    });
    g.players[0].hand = [C('head', 'red'), C('butt', 'red'), C('wolf')];
    g.turn = 0; g.pending = null;
    g.log.push({ n: ++g.seq, text: '[test] 4-player deal rigged' });
    manager.armTimer(room); manager.broadcast(room);
    return res.end('ok');
  }
  const [a, b] = g.players;
  const orangeHead = C('head', 'orange'); const greenButt = C('butt', 'green'); const paint = C('paint');
  a.hand = [C('head', 'red'), C('butt', 'red'), C('butt', 'orange'), C('wolf'), C('itslam', null, { effect: 'lure2' }), C('butt', 'rainbow')];
  a.field = [];
  b.hand = [C('reflip'), C('head', 'blue'), C('wheat')];
  b.field = [
    { id: 's901', cards: [orangeHead, greenButt], modifier: paint },
    { id: 's902', cards: [C('head', 'cyan'), C('butt', 'cyan')], modifier: null },
    { id: 's903', cards: [C('head', 'rainbow'), C('butt', 'mint')], modifier: null },
  ];
  g.deck = [C('head', 'grey'), C('butt', 'grey')];
  g.discard = [];
  g.turn = 0; g.pending = null; g.itslamPlayedThisTurn = false;
  g.log.push({ n: ++g.seq, text: '[test] deal rigged' });
  manager.armTimer(room); manager.broadcast(room);
  res.end('ok');
}).listen(PORT + 1, '127.0.0.1');
