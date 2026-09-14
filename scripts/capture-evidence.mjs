#!/usr/bin/env node
// capture-evidence.mjs — standard screenshots of one app version, report-ready.
//
//   npm run capture-evidence [-- <label>] [-- --allow-dirty]
//
// Serves the repo with `python3 -m http.server`, drives headless Google Chrome
// over the DevTools Protocol (Node's built-in WebSocket — no Puppeteer/Playwright)
// and captures a FIXED scene list at two viewports into evidence/<label>/:
//   desktop 1440×900, and mobile 390×844 (DPR 2, touch, Android UA).
// Label defaults to the git tag on HEAD, else the short sha. Also writes
// evidence/<label>/manifest.json + DEVICE/README.md and prepends a section to
// evidence/INDEX.md (newest first). Tooling only; never modifies the app.
//
// Determinism: Math.random is replaced by a fixed-seed PRNG before any page
// script runs, every scene starts from a fresh load, and camera placement is
// fixed. Live market data (token set, prices) and animation phase still vary
// between runs — that's the real product state at capture time.
//
// Privacy: the relay is pointed at a closed local port, so the capture never
// joins the live room and no other user's avatar or .chain name can appear; no
// wallet is connected (the run aborts if one is); wallet/identity/tip UI is
// hidden before every capture.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence");
const PORT = Number(process.env.EVIDENCE_PORT) || 8931;
const SEED = 20260914;
const MAX_PNG_BYTES = 300 * 1024;
const CLOSED_RELAY = "ws://127.0.0.1:9"; // nothing listens here → relay stays disconnected
const CHROME = process.env.CHROME_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false },
  { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true, ua: ANDROID_UA },
];

// Each scene runs on a fresh load. `setup` is evaluated in the page and may
// return {skip: reason} when the feature isn't in this build.
const SCENES = [
  { name: "overview-firstload", settle: 0, setup: `({})` },
  {
    name: "closeup-labels", settle: 3000, // label ranking refreshes every 2.5 s
    setup: `(() => {
      const w = __wm, n = [...w.nodeData].filter((n) => n.alive && n.pos).sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0];
      if (!n) return { skip: "no live nodes" };
      w.rig.position.set(n.pos.x, n.pos.y, n.pos.z + 7); w.setYaw(0);
      return { node: n.word };
    })()`,
  },
  {
    name: "detail-card-open", settle: 3500, // sparkline fetch
    setup: `(() => {
      const w = __wm, alive = [...w.nodeData].filter((n) => n.alive);
      const n = alive.find((n) => n.word === "AETERNITY") || alive.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0];
      if (!n) return { skip: "no live nodes" };
      w.selectNode(n);
      return { node: n.word };
    })()`,
  },
  { name: "search-open", settle: 1500, setup: `(__wm.openSearch(), {})` },
  { name: "menu-open", settle: 1500, setup: `(typeof __wm.openMenu === "function" ? (__wm.openMenu(), {}) : { skip: "no menu in this build" })` },
  { name: "landmarks", settle: 2500, setup: `(typeof __wm.showLandmarks === "function" ? (__wm.showLandmarks(), {}) : { skip: "no landmarks in this build" })` },
];

// Runs right before every capture. Aborts on a connected wallet; hides anything
// that could show an address, balance, tip or another user.
const PRIVACY_GUARD = `(() => {
  const w = __wm;
  if (w.wallet && w.wallet.connected) return { abort: "a wallet is connected — refusing to capture" };
  const hidden = [];
  for (const sel of ["#identity-chip", "#tip-prompt", "#tip-toast"]) {
    const el = document.querySelector(sel);
    if (el) { el.style.visibility = "hidden"; hidden.push(sel); }
  }
  let avatars = 0;
  for (const e of w.remoteAvatars.values()) { e.group.visible = false; avatars++; }
  return { hidden, remoteAvatarsHidden: avatars, relayConnected: w.relayReady };
})()`;

const PRNG = `(() => {
  let s = ${SEED} >>> 0;
  Math.random = function () { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).trim();

/* ---------------- minimal CDP client ---------------- */
class CDP {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = res; this.ws.onerror = rej;
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        const p = m.id && this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
      };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej, method }));
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evaluate(cdp, sid, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error("page eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

async function waitFor(cdp, sid, expression, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await evaluate(cdp, sid, expression); if (last && last.ok) return last; } catch (e) { last = String(e.message); }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

async function screenshot(cdp, sid, vp) {
  // Downscale until the PNG fits the size budget.
  for (const scale of [1, 0.8, 0.65, 0.5, 0.4, 0.3]) {
    const r = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale }, // output px = CSS px × scale × DPR
    }, sid);
    const buf = Buffer.from(r.data, "base64");
    if (buf.length <= MAX_PNG_BYTES || scale === 0.3) return { buf, scale, px: `${Math.round(vp.width * scale * vp.dpr)}×${Math.round(vp.height * scale * vp.dpr)}` };
  }
}

/* ---------------- index + manifest helpers ---------------- */
function latestChangeLine() {
  const lines = readFileSync(join(ROOT, "CLAUDE.md"), "utf8").split("\n").filter((l) => /^- \d{4}-\d{2}-\d{2}: /.test(l));
  const last = lines[lines.length - 1] || "";
  const bold = last.match(/\*\*(.+?)\*\*/);
  return (bold ? bold[1] : last.replace(/^- /, "")).replace(/`/g, "").slice(0, 200);
}

const INDEX_HEAD = `# WordMesh evidence index

Report source: one section per captured version, newest first. Automated captures come from
\`npm run capture-evidence\` (desktop 1440×900; mobile 390×844, Android UA). Real-device shots
are added by hand to each version's \`DEVICE/\` folder and listed here on the next capture run.
Evidence is never deployed (\`evidence/\` is in \`.pages-exclude\`).

<!-- evidence:sections -->
`;

function upsertIndexSection(label, body) {
  const file = join(EVIDENCE, "INDEX.md");
  let text = existsSync(file) ? readFileSync(file, "utf8") : INDEX_HEAD;
  if (!text.includes("<!-- evidence:sections -->")) text = INDEX_HEAD + "\n" + text;
  const open = `<!-- evidence:${label} -->`, close = `<!-- /evidence:${label} -->`;
  const block = `${open}\n${body.trim()}\n${close}\n`;
  const i = text.indexOf(open), j = text.indexOf(close);
  if (i >= 0 && j > i) text = text.slice(0, i) + block + text.slice(j + close.length + 1);
  else text = text.replace("<!-- evidence:sections -->\n", `<!-- evidence:sections -->\n\n${block}`);
  writeFileSync(file, text.replace(/\n{3,}/g, "\n\n"));
}

function deviceFiles(label) {
  const dir = join(EVIDENCE, label, "DEVICE");
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort() : [];
}

function indexBody(manifest) {
  const { label, date, sha, changes, captures } = manifest;
  const cell = (scene, vp) => {
    const c = captures.find((x) => x.scene === scene && x.viewport === vp);
    return c && c.file ? `<img src="${label}/${c.file}" width="${vp === "desktop" ? 360 : 150}" alt="${scene} ${vp}">` : "—";
  };
  const scenes = [...new Set(captures.map((c) => c.scene))];
  const rows = scenes.map((s) => {
    const skipped = captures.find((c) => c.scene === s && c.skipped);
    return skipped ? `| ${s} | _${skipped.skipped}_ | |` : `| ${s} | ${cell(s, "desktop")} | ${cell(s, "mobile")} |`;
  });
  const dev = deviceFiles(label);
  return `## ${label} — ${date.slice(0, 10)}

- **sha:** \`${sha}\`  ·  **captured:** ${date}
- **changes:** ${changes}

| scene | desktop 1440×900 | mobile 390×844 |
|---|---|---|
${rows.join("\n")}

**Device shots:** ${dev.length ? dev.map((f) => `<img src="${label}/DEVICE/${f}" width="150" alt="${f}">`).join(" ") : `none yet — drop \`quest-<scene>.jpg\`, \`iphone-<scene>.jpg\`, \`android-<scene>.jpg\` into \`${label}/DEVICE/\``}
`;
}

const DEVICE_README = (label) => `# Real-device shots for ${label}

Drop screenshots taken on real hardware here, by hand. Headless capture can't
enter VR/AR or use real touch, so these are the only proof of those paths.

Naming (scene names match the automated captures one folder up):

- \`quest-<scene>.jpg\`   — Meta Quest browser / immersive session
- \`iphone-<scene>.jpg\`  — iPhone Safari
- \`android-<scene>.jpg\` — Android Chrome

e.g. \`quest-detail-card-open.jpg\`, \`iphone-search-open.jpg\`. Crop or blur any
wallet address, balance or other private data before committing — this repo is
public. Re-run \`npm run capture-evidence -- ${label}\` (or edit evidence/INDEX.md)
to list them.
`;

/* ---------------- one-time historical seed ---------------- */
function seedPreV1() {
  const dir = join(EVIDENCE, "pre-v1");
  if (existsSync(join(dir, "manifest.json"))) return;
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if ([".git", "node_modules", "evidence", "_drafts", "_private", ".claude"].includes(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(png|jpe?g)$/i.test(e.name)) found.push(p);
    }
  };
  walk(ROOT);
  mkdirSync(dir, { recursive: true });
  const files = found.map((src) => { const name = relative(ROOT, src).replace(/[\\/]/g, "__"); copyFileSync(src, join(dir, name)); return { from: relative(ROOT, src), file: name }; });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    label: "pre-v1", historical: true, structured: false,
    note: "Screenshots that existed before the evidence pipeline, copied as-is (not moved). No fixed scenes, viewports or seed.",
    searched: ["verification/", "every *.png/*.jpg in the repo tree (excluding .git, evidence, _drafts, _private)"],
    date: new Date().toISOString(), files,
  }, null, 2) + "\n");
  upsertIndexSection("pre-v1", `## pre-v1 — historical, unstructured

${files.length ? files.map((f) => `<img src="pre-v1/${f.file}" width="240" alt="${f.from}">`).join(" ") : "_No earlier screenshots existed locally when the pipeline was created (`verification/` was never committed). Nothing to seed._"}
`);
}

/* ---------------- main ---------------- */
async function main() {
  const args = process.argv.slice(2);
  const allowDirty = args.includes("--allow-dirty");
  const sha = git("rev-parse", "HEAD");
  let tag = ""; try { tag = execFileSync("git", ["describe", "--exact-match", "--tags", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  const label = args.find((a) => !a.startsWith("--")) || tag || sha.slice(0, 7);
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`bad label: ${label}`);
  const dirty = git("status", "--porcelain", "--untracked-files=no").split("\n").filter((l) => l && !l.slice(3).startsWith("evidence/"));
  if (dirty.length && !allowDirty) throw new Error(`working tree has uncommitted app/tooling changes — the capture wouldn't match ${sha.slice(0, 7)}:\n${dirty.join("\n")}\n(commit first, or pass --allow-dirty)`);

  const outDir = join(EVIDENCE, label);
  mkdirSync(join(outDir, "DEVICE"), { recursive: true });
  console.log(`[evidence] ${label} @ ${sha.slice(0, 7)} → ${relative(ROOT, outDir)}/`);

  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  const profile = mkdtempSync(join(tmpdir(), "wm-evidence-"));
  let chrome, cdp;
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch {}
      if (i > 40) throw new Error("static server didn't start");
      await sleep(250);
    }
    chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise((res, rej) => {
      let err = ""; const t = setTimeout(() => rej(new Error("Chrome didn't expose DevTools: " + err.slice(-400))), 20000);
      chrome.stderr.on("data", (d) => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
      chrome.on("exit", (c) => rej(new Error(`Chrome exited (${c}): ${err.slice(-400)}`)));
    });
    cdp = new CDP(wsUrl); await cdp.open();

    const captures = [];
    for (const vp of VIEWPORTS) {
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sid);
      await cdp.send("Runtime.enable", {}, sid);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile }, sid);
      if (vp.mobile) {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sid);
        await cdp.send("Emulation.setUserAgentOverride", { userAgent: vp.ua, platform: "Android" }, sid);
      }
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PRNG }, sid);

      for (const scene of SCENES) {
        const url = `http://127.0.0.1:${PORT}/index.html?relay=${encodeURIComponent(CLOSED_RELAY)}&evidence=${encodeURIComponent(label)}`;
        await cdp.send("Page.navigate", { url }, sid);
        await waitFor(cdp, sid, `(() => { const w = window.__wm; return { ok: !!w && w.badgeEl.textContent === "LIVE DATA" && w.nodeData.some((n) => n.alive), badge: w && w.badgeEl.textContent }; })()`, 60000, "LIVE DATA");
        await sleep(4000); // first-load settle: labels ranked, replay pulses running
        const info = await evaluate(cdp, sid, scene.setup);
        if (info && info.skip) {
          captures.push({ scene: scene.name, viewport: vp.name, skipped: info.skip });
          console.log(`[evidence]   ${scene.name}-${vp.name}: skipped (${info.skip})`);
          continue;
        }
        await sleep(scene.settle);
        const guard = await evaluate(cdp, sid, PRIVACY_GUARD);
        if (guard.abort) throw new Error(guard.abort);
        await sleep(200);
        const shot = await screenshot(cdp, sid, vp);
        const file = `${scene.name}-${vp.name}.png`;
        writeFileSync(join(outDir, file), shot.buf);
        captures.push({ scene: scene.name, viewport: vp.name, file, bytes: shot.buf.length, pixels: shot.px, ...(info.node ? { node: info.node } : {}), privacy: guard });
        console.log(`[evidence]   ${file}  ${(shot.buf.length / 1024).toFixed(0)} KB  ${shot.px}${info.node ? "  node=" + info.node : ""}`);
      }
      await cdp.send("Target.closeTarget", { targetId });
    }

    const manifest = {
      label, sha, date: new Date().toISOString(), changes: latestChangeLine(),
      seed: SEED, relay: "disabled for capture (closed local port)", data: "live api.superhero.com at capture time",
      viewports: VIEWPORTS.map(({ name, width, height, dpr, mobile, ua }) => ({ name, width, height, dpr, mobile, ...(ua ? { ua } : {}) })),
      captures,
    };
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    if (!existsSync(join(outDir, "DEVICE", "README.md"))) writeFileSync(join(outDir, "DEVICE", "README.md"), DEVICE_README(label));
    seedPreV1();
    upsertIndexSection(label, indexBody(manifest));
    console.log(`[evidence] wrote ${relative(ROOT, join(outDir, "manifest.json"))} and evidence/INDEX.md`);
  } finally {
    cdp?.close();
    chrome?.kill();
    server.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => { console.error("[evidence] FAILED:", e.message); process.exit(1); });
