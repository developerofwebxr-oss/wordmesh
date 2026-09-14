// WordMesh presence relay — the ONLY backend. A tiny WebSocket hub: one shared
// room, rebroadcast each client's presence heartbeat to the others, announce
// leaves on disconnect, and forward tips ONLY after proving them on chain.
// Holds no keys, no funds, no secrets — it only READS the public aeternity node.
// Deploy anywhere that runs `npm start` and gives a wss:// URL
// (Render / Railway / Fly free tiers, a $4 VPS, etc). ~zero cost at this scale.
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8090;
const NODE_URL = process.env.AE_NODE_URL || "https://mainnet.aeternity.io";
// Tip verification — env overrides exist so tests can use a short window.
const TIP_VERIFY_TIMEOUT_MS = Number(process.env.TIP_VERIFY_TIMEOUT_MS) || 90_000; // give up on unmined txs
const TIP_VERIFY_POLL_MS = Number(process.env.TIP_VERIFY_POLL_MS) || 3_000;
const TIP_MAX_AGE_KEYBLOCKS = Number(process.env.TIP_MAX_AGE_KEYBLOCKS) || 20;     // ~1 h: no replaying old tips after a restart
const TIP_MAX_INFLIGHT_PER_SOCKET = 3;
const TIP_MAX_PER_MIN_PER_SOCKET = 10;
const TIP_MAX_INFLIGHT_TOTAL = 100;
const TIP_SEEN_MAX = 5000;                                                          // broadcast hashes remembered (LRU)
const TH_RE = /^th_[1-9A-HJ-NP-Za-km-z]{45,52}$/;                                   // base58check of a 32-byte hash

const wss = new WebSocketServer({ port: PORT, maxPayload: 16 * 1024 });
const ids = new Map(); // ws -> assigned id
let seq = 0;

const bcast = (from, obj) => {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws !== from && ws.readyState === 1) ws.send(s);
};
const log = (...a) => console.log("[wordmesh-relay]", ...a);

/* ---------------- Tip verification (fail closed) ----------------
   A tip beam claims value moved, so the relay never forwards what a client
   says. Clients send only {t:"tip", th}; the relay looks the hash up on the
   node and broadcasts {t:"tip", th, from, to, amount, verified:true} with every
   field taken FROM THE CHAIN — and only for a mined, recent, person-to-person
   SpendTx. Any doubt (timeout, node error, odd shape) → nothing is broadcast. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const aettosToAe = (s) => {
  const a = BigInt(s), unit = 10n ** 18n;
  const frac = (a % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${a / unit}.${frac}` : `${a / unit}`;
};
async function nodeGet(path) {
  const r = await fetch(NODE_URL + path, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, text: r.ok ? await r.text() : "" };
}
// → { ok:true, from, to, amount } | { ok:false, reason }
async function verifyTip(th) {
  if (typeof fetch !== "function") return { ok: false, reason: "no fetch in this runtime" };
  const deadline = Date.now() + TIP_VERIFY_TIMEOUT_MS;
  let lastReason = "not found";
  while (Date.now() < deadline) {
    try {
      const { status, text } = await nodeGet(`/v3/transactions/${th}`);
      if (status === 400) return { ok: false, reason: "invalid hash (node 400)" };
      if (status === 200) {
        const j = JSON.parse(text), t = j.tx || {};
        const aettos = (text.match(/"amount":\s*(\d+)/) || [])[1]; // raw text: 10 AE = 1e19 aettos, past 2^53
        if (j.hash !== th || t.type !== "SpendTx") return { ok: false, reason: "not a SpendTx" };
        if (!/^ak_/.test(t.sender_id || "") || !/^ak_/.test(t.recipient_id || "") || t.sender_id === t.recipient_id)
          return { ok: false, reason: "not person-to-person" };
        if (!aettos || aettos === "0") return { ok: false, reason: "zero amount" };
        if (j.block_height > 0) {
          const h = await nodeGet("/v3/key-blocks/current/height");
          const top = h.status === 200 ? JSON.parse(h.text).height : NaN;
          if (!(top - j.block_height <= TIP_MAX_AGE_KEYBLOCKS)) return { ok: false, reason: `too old or unknown age (mined at ${j.block_height}, top ${top})` };
          return { ok: true, from: t.sender_id, to: t.recipient_id, amount: aettosToAe(aettos) };
        }
        lastReason = "still in mempool";
      } else if (status !== 404) lastReason = `node ${status}`;
    } catch (e) { lastReason = "node unreachable: " + (e && e.message || e); }
    await sleep(TIP_VERIFY_POLL_MS);
  }
  return { ok: false, reason: `timeout (${lastReason})` };
}

const tipSeen = new Set();       // hashes already broadcast — insertion-ordered, oldest evicted
const tipInflight = new Set();   // hashes being verified right now
const rememberTip = (th) => {
  tipSeen.add(th);
  if (tipSeen.size > TIP_SEEN_MAX) tipSeen.delete(tipSeen.values().next().value);
};
function onTipSubmit(ws, id, m) {
  const now = Date.now();
  ws._tipTimes = (ws._tipTimes || []).filter((t) => now - t < 60_000);
  ws._tipInflight = ws._tipInflight || 0;
  if (ws._tipTimes.length >= TIP_MAX_PER_MIN_PER_SOCKET || ws._tipInflight >= TIP_MAX_INFLIGHT_PER_SOCKET || tipInflight.size >= TIP_MAX_INFLIGHT_TOTAL) {
    if (!ws._tipLimitLogged || now - ws._tipLimitLogged > 60_000) { ws._tipLimitLogged = now; log(id, "tip dropped: rate limit"); }
    return;
  }
  ws._tipTimes.push(now);
  const th = typeof m.th === "string" ? m.th : "";
  if (!TH_RE.test(th)) return log(id, "tip dropped: malformed th");
  if (tipSeen.has(th) || tipInflight.has(th)) return log(id, "tip dropped: duplicate", th);
  tipInflight.add(th); ws._tipInflight++;
  verifyTip(th)
    .then((v) => {
      if (!v.ok) return log(id, "tip dropped:", v.reason, th);
      if (tipSeen.has(th)) return;
      rememberTip(th);
      bcast(ws, { t: "tip", th, from: v.from, to: v.to, amount: v.amount, verified: true });
      log(id, "tip verified + broadcast", th, v.from, "->", v.to, v.amount, "AE");
    })
    .catch((e) => log(id, "tip dropped: verify error", e && e.message || e))
    .finally(() => { tipInflight.delete(th); ws._tipInflight--; });
}

wss.on("connection", (ws) => {
  const id = "u" + (++seq).toString(36);
  ids.set(ws, id);
  ws.send(JSON.stringify({ t: "welcome", id }));
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object") return; // e.g. "null" — m.t would throw and kill the process
    try {
      if (m.t === "presence") {
        // trust the server-assigned id, not the client's claim (unspoofable here)
        bcast(ws, { t: "presence", id, p: m.p, yaw: m.yaw, name: m.name, seed: m.seed });
      } else if (m.t === "tip") {
        onTipSubmit(ws, id, m);
      }
    } catch (e) { log(id, "message handler error:", e && e.message || e); }
  });
  ws.on("close", () => { ids.delete(ws); bcast(ws, { t: "leave", id }); });
  ws.on("error", () => {});
});
process.on("unhandledRejection", (e) => log("unhandled rejection:", e && e.message || e));
log(`listening on :${PORT} (tips verified against ${NODE_URL})`);
