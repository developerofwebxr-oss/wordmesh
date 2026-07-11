// WordMesh presence relay — the ONLY backend. A tiny stateless WebSocket hub:
// one shared room, rebroadcast each client's presence heartbeat to the others,
// announce leaves on disconnect. Holds no secrets, no state beyond the live
// socket set. Deploy anywhere that runs `npm start` and gives a wss:// URL
// (Render / Railway / Fly free tiers, a $4 VPS, etc). ~zero cost at this scale.
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8090;
const wss = new WebSocketServer({ port: PORT });
const ids = new Map(); // ws -> assigned id
let seq = 0;

const bcast = (from, obj) => {
  const s = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws !== from && ws.readyState === 1) ws.send(s);
};

wss.on("connection", (ws) => {
  const id = "u" + (++seq).toString(36);
  ids.set(ws, id);
  ws.send(JSON.stringify({ t: "welcome", id }));
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.t === "presence") {
      // trust the server-assigned id, not the client's claim (unspoofable here)
      bcast(ws, { t: "presence", id, p: m.p, yaw: m.yaw, name: m.name, seed: m.seed });
    } else if (m.t === "tip") {
      // a confirmed 10 AE tip — rebroadcast so peers draw the beam + the
      // recipient sees the received effect. Identity fields are the on-chain
      // addresses (from/to); `id` is the sender's socket for provenance.
      bcast(ws, { t: "tip", id, from: m.from, to: m.to, amount: m.amount, txHash: m.txHash });
    }
  });
  ws.on("close", () => { ids.delete(ws); bcast(ws, { t: "leave", id }); });
  ws.on("error", () => {});
});
console.log(`[wordmesh-relay] listening on :${PORT}`);
