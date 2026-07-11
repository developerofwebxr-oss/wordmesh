# WordMesh presence relay

Tiny WebSocket hub so users see each other in the mesh. One room, rebroadcasts
`{t:'presence', p:[x,y,z], yaw, name, seed}` heartbeats to peers, announces
`{t:'leave', id}` on disconnect. No secrets, no database.

## Run locally
    npm install && npm start        # ws://localhost:8090

## Deploy (pick one — all give a wss:// URL the static client uses)
- **Render**: New → Web Service → this repo/`server` dir → Build `npm install`,
  Start `npm start`. Free tier sleeps after idle (~cold start); fine for testing.
- **Railway / Fly.io**: same `npm start`; small always-on instances.
- **$4–6/mo VPS** (Hetzner/DigitalOcean): `npm start` behind a TLS reverse proxy
  (Caddy auto-HTTPS) — always on, you control it.
- **Cloudflare Durable Object** (WS): near-free at this scale, nothing to babysit
  (needs the handler rewritten to the Workers WS API — not this Node file).

Then point the client at it: append `?relay=wss://your-host` to the WordMesh
URL, or bake it into `DEFAULT_RELAY` in index.html.
