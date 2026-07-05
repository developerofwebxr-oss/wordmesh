# WordMesh — Execution Spec (CLAUDE.md)

Read this whole file before touching code. Strategy is LOCKED (decided 2026-07-05, with full research). Do not re-litigate decisions in the "Locked decisions" section — execute them. See WORDMESH_BRIEF.md for the why.

## What this is
A live, walkable 3D network of the Superhero.com (aeternity) word-token economy. WebXR, one link, runs on desktop / mobile touch / Quest VR / AR passthrough. Word-tokens are glowing nodes (size/brightness = Trendminer price/volume). Creators and `.chain` users are nodes. Real buys/tips travel as light-pulses down lines between nodes. Erlang aesthetic: message-passing mesh that self-heals when nodes drop.

## Locked decisions — do not reopen
1. Live network floor, not ambient drift. The mesh visibly reacts to trade events. Nodes flare, dim, lines reroute.
2. No audio mechanics. No calls. Optional faint accent sound at most, default silent. Erlang is expressed structurally (mesh, self-healing, load-as-brightness), never as telephony.
3. Two distinct verbs, never conflated: BUY a word (Trendminer, bonding-curve market) vs TIP a post/creator (tipping contract, social gift). Words are not tipped. Visual grammar: buys thicken/brighten word-nodes; tips draw person→person support-lines.
4. Non-custodial, reads-first. All rendering runs on free reads (REST/WS/node). Writes (buy/tip) happen ONLY via Superhero Wallet handoff (QR to phone / deep-link). We never hold keys. Writes are phase 3.
5. Data-adapter seam. All data flows through a `DataSource` interface. `MockSource` and `SuperheroSource` are interchangeable. Engine stays chain-agnostic.
6. Replay layer. Real live volume is tiny (<$1k/day chain-wide). Under the live WS feed, run a time-compressed replay of the last ~7 days of real trades, clearly labeled ("replay" vs "live" pulses, e.g. dimmer/cooler colored). The room must always breathe.
7. Presence privacy line (phase 2): other users appear as callsign (.chain name) + words they explicitly claim/broadcast. NEVER visualize someone's holdings/portfolio.
8. Single-file phase 0. One `index.html`, Three.js from CDN, deployed on GitHub Pages. No build step until it hurts.
9. Human nodes are embodied and mobile. `.chain` users = pill-shaped avatars with cut-sphere faces (port the Nostr XR stage avatar style) + floating callsign. Locomotion: walk/run on an implied plane AND free flight through the constellation (fly is the default in a 3D mesh; smooth locomotion + snap-turn in VR, WASD+mouse desktop, touch+gyro mobile — per webxr-threejs skill patterns).
10. Free to roam, paid to interact (phase 4 economy). Seeing, walking/flying, and discovering is always free. Economic interactions cost AE and settle on-chain non-custodially: payload-tagged spend transactions to the dev's `.chain` wallet (client verifies via middleware read — the chain is the store, no backend accounts), plus one small Sophia split-contract for avatar-to-avatar gifts (~95% recipient / ~5% dev). Never paywall movement or visibility.

## Architecture
- Client: static, GitHub Pages. Three.js + WebXR. Mode switcher: desktop (orbit/WASD) / mobile (touch + gyro) / VR (Quest controllers) / AR passthrough. Use the `webxr-threejs` skill and `threejs-visual-polish` skill if available (guidance, not dependencies).
- Backend: none until forced. Railway proxy ONLY if CORS check fails (then it also does caching). Secrets never in client.
- Data endpoints (names from `superhero-com/superhero` `src/config.ts`, verified 2026-07): `SUPERHERO_API_URL` (Trendminer REST: trending list, candles), `SUPERHERO_WS_URL` (live trade events), `NODE_URL` / `MIDDLEWARE_URL` (aeternity node + middleware: `.chain` resolution, on-chain reads), `WALLET_URL` (wallet handoff), `PROFILE_REGISTRY_CONTRACT_ADDRESS` (on-chain profiles). First build task of phase 1: capture the concrete URL values + CORS headers from superhero.com devtools; not confirmed in research.

### DataSource interface (keep this exact seam)
```js
// getSnapshot(): Promise<{tokens: [{word, price, volume24h, holders?, candles?}]}>
// subscribe(cb): live events {type: 'buy'|'sell'|'tip', word?, from?, to?, amount, ts}
// getReplay(days): Promise<event[]>  // same event shape, historical
```
`MockSource` generates plausible data + Poisson-timed events. `SuperheroSource` implements the same against REST/WS. Swap via `?data=mock|live` query param.

## Performance budget (Quest = floor)
72fps on Quest. Word-nodes via `InstancedMesh` (one draw call), cap ~300 visible nodes, LOD: distant nodes = point sprites, no labels. All lines in one `LineSegments` buffer, rebuilt at most 1×/s; pulses are shader/uv animations, not per-pulse objects. Labels: billboarded canvas textures, only within ~8m, pooled. No per-frame allocations in the render loop.

## Phases + acceptance criteria

### Phase 0 — mock mesh demo (ship same-day)
Single `index.html` on Pages. MockSource. ~150–300 word-nodes in 3D constellation around spawn, related-word lines, event pulses firing every few seconds, node flare/dim on events, one node dies + mesh visibly reroutes every ~60s (the Erlang beat). HUD: project name + "mock data" badge + mode switcher.
Done when: loads from Pages link; 72fps in Quest browser; usable on desktop mouse + phone touch; a 30s screen capture looks alive.

### Phase 1 — real data
Devtools probe of superhero.com → record real endpoint URLs + CORS verdict in this file. Implement `SuperheroSource` (REST snapshot → node sizes; WS → live pulses; middleware/API history → replay layer). Railway proxy only if CORS forces; keep client static either way. Live pulses visually distinct from replay pulses.
Done when: `?data=live` renders the actual current Trendminer top tokens with real prices, and a real trade visibly pulses in-world.

### Phase 2 — identity & presence
`.chain` name entry (read-only resolve via middleware + profile registry) → you become an embodied avatar: pill body, cut-sphere face, floating callsign (locked decision 9), full walk/run/fly locomotion, with lines to words you claim. Creator nodes for top tipped creators. Presence: bot-avatars first, LiveKit real presence later behind the same seam. Respect the privacy line (locked decision 7).

### Phase 3 — writes (buy / tip)
Select word-node → "back this word" → styled QR → user scans with Superhero mobile app → deep-link to buy. Same for tipping a creator-node. Client never signs, never holds keys. On confirmation (seen via WS/middleware), fire the user's own pulse in-world.

### Phase 4 — in-world economy (the link starts earning)
Free-to-roam stays absolute (locked decision 10). Paid interactions via the same QR/deep-link handoff: cosmetics (payload `wm:glow:7d` etc), beacons (`wm:beacon:<word>:<ttl>`), orbit slots (weekly), avatar-to-avatar gifts (one Sophia split-contract ~95/5). Moderation guard on user text. Client verifies confirmed txs via middleware; chain is the store.

### Phase 4+ revenue scaling
B2B placements ($100–500/mo sponsored beacons/branded zones), weekly auctions for scarcity, scheduled market-night events, and semantic ad inventory (affiliate auto-fill, Zesty Market programmatic, direct placements via placements.json, brand-owned words with custom GLTF nodes gated to on-chain verified owners). Ad integrity (hard): every ad labeled "ad"; ad payments NEVER influence node size/brightness/position; no ads on avatars or `.chain` identities; billboards excluded from replay/live pulse grammar.

## Session workflow
- Model: Sonnet for phase 0–1; Opus for Quest perf tuning / phase-2 presence / stubborn data-layer. Strategy is settled.
- Each session: read this file first, check Status log, do the next unchecked criterion, update the log.
- Verify on-device claims honestly: if you can't test Quest fps in-session, say so and list what the user must check.

## Status log
- 2026-07-05: Strategy locked. Docs created. Repo: github.com/developerofwebxr-oss/wordmesh (Pages enabled). Endpoints unprobed. Phase 0 not started.

## Facts that shape tone/claims (verified 2026-07)
- Business model: monthly sponsorship, NOT grants/bounties. Aeternity/Superhero is sponsor #1. Pitch happens AFTER phase 0 ships. Never use grant/bounty language in drafted material.
- Each phase doubles as a monthly sponsor deliverable. Superhero case exclusively — keep DataSource/write seams clean but don't build for hypothetical rails.
- AE ≈ $0.006–0.008, chain-wide volume <$1k/day — hence the replay layer.
- Superhero mobile app newly launched; QR write-handoff stars it; store links carry attribution tags.

## Sponsor-reporting instrumentation
- Phase 0+: tag all outbound store/app links (`?ref=wordmesh`); keep a simple privacy-light visit counter.
- Phase 2: register the project's own `.chain` name.
- Phase 4: in-world economy revenue reporting.
- Every phase ships with a 20–30s capture clip.
