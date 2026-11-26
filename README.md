# Sheep Looking Online

This is a browser-playable, online multiplayer (2–4 players) version of **"Is That Sheep Looking At Me? The Card Game"**. The rules come from the publisher's how-to-play video (https://www.youtube.com/watch?v=0o2nsB1hVK0). The rules follow the official **Print & Play** rulebook where it is more specific than the video. See [`docs/RULES_SPEC.md`](docs/RULES_SPEC.md) for the rule spec and sources.

> It is an unofficial fan implementation. The game and **all card artwork** (`public/cards/`, cropped from the official Print & Play PDF) are by Zedaph & DotDotDash, published by CREO Cards. The artwork is theirs: it's fine for playing with friends, but get the publisher's permission before running this as a public service.

## Features
- Private rooms with a 5-character code and a shareable link (`/r/CODE`). Up to 4 players, hard cap.
- **Quick match** joins public lobbies. A public lobby starts 30 s after the 2nd player connects, or right away at 4. The host can start early.
- Server-authoritative rules. Clients send *intentions* only. The server validates turns, cards and targets, rolls the coin and shuffles with `crypto`, and sends each player only their own hand.
- Reconnect: the seat is kept in `localStorage`, so refreshing or losing signal puts you back in your seat.
- Turn and decision timers: **18 s per turn, restarting every time you play a card**, and 40 s per coin-flip decision. If the player is disconnected, it's 25 s before an automatic move. After 3 minutes disconnected the player is dropped from the game, which continues.
- Safeguards: sanitised names, payload size limits, per-socket rate limiting, join-attempt limits, open-room cap per IP, a strict CSP, no accounts, no chat.

## Run locally
Requires Node.js 20+.
```bash
npm install
npm start            # http://localhost:3000
npm test             # rules engine + real-socket multiplayer tests
```
To play with yourself, open the URL in two or more browser windows (use a private window or another browser for each player). To test on a phone on the same Wi-Fi, open `http://<your-computer-LAN-IP>:3000`.

## Deploy (one Node service hosts both the client and the WebSocket server)
Any host that supports long-running Node processes **and WebSockets** works. Run **exactly one instance**, because game state lives in memory.

**Render, free plan** (`render.yaml` included): push this folder to a GitHub repo, then in Render choose *New → Blueprint* and select the repo. The free plan sleeps after 15 minutes with no visitors and no game traffic. The first visit after that takes about a minute to wake it, and a sleep or redeploy ends any games in progress. Change `plan: free` to `starter` for always-on.

**Fly.io** (`fly.toml` + `Dockerfile` included):
```bash
fly launch --copy-config --no-deploy   # pick a unique app name
fly deploy
fly scale count 1
```

**Docker anywhere:**
```bash
docker build -t sheep-online .
docker run -p 3000:3000 -e TRUST_PROXY=1 sheep-online
```
Put it behind HTTPS (for example Caddy, nginx or a platform load balancer) and make sure the proxy forwards WebSocket upgrades.

### Environment variables (all optional)
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `TRUST_PROXY` | `loopback` | Set to `1` behind one reverse proxy so client IPs are correct for limits |
| `ALLOWED_ORIGINS` | *(same origin)* | Comma-separated origins, only if you host the client on a different domain |
| `TURN_SECONDS` / `DECISION_SECONDS` | 18 / 40 | Turn timer (restarts after each card played) / coin-flip decisions |
| `DISCONNECTED_TURN_SECONDS` / `DROP_AFTER_SECONDS` | 25 / 180 | Disconnect handling |
| `PUBLIC_AUTOSTART_SECONDS` | 30 | Public lobby countdown |
| `MAX_ROOMS`, `MAX_ROOMS_PER_IP` | 500, 6 | Abuse limits |

## Project layout
```
shared/cards.js      card data + sheep validity (used by server and client)
server/engine.js     authoritative rules engine (pure, testable)
server/rooms.js      rooms, matchmaking, timers, reconnects, per-player views
server/index.js      Express static hosting + Socket.IO API + safeguards
public/              client (vanilla ES modules, no build step); public/cards = Print & Play card art
test/                node:test suites; ui-harness.js = test-only rigged server for browser scripts
docs/RULES_SPEC.md   video analysis and rule specification
```

## Limits
- State is in memory. A server restart or redeploy ends games in progress, and you can't run more than one instance without adding a shared store (e.g. the Redis adapter plus persisted rooms).
- Matchmaking is simple first-come lobby filling, with no skill rating or region selection.
- There is no chat or spectating. Names are the only user text.
- Ambiguities in the source rules are listed in `docs/RULES_SPEC.md`, and the app follows the choices recorded there.
