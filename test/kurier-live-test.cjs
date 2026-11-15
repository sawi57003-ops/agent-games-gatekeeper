// One-off live test: real Kurier mainnet submission through the real handler.
// Reads the key from ~/.kurier/api-key.json (600) — never from argv/env.
// Usage: node test/kurier-live-test.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const SECRET = "live-test-secret-" + Date.now();
const PORT = 18799;
const BASE = `http://127.0.0.1:${PORT}`;
const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const SEEN = "/tmp/gk-live-seen.json";
try { fs.unlinkSync(SEEN); } catch {}

const keyFile = path.join(os.homedir(), ".kurier", "api-key.json");
const KURIER_API_KEY = JSON.parse(fs.readFileSync(keyFile, "utf8")).key;

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}
async function post(pathname, obj) {
  const body = JSON.stringify(obj);
  const res = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sign(body) },
    body,
  });
  return { status: res.status, text: await res.text(), sig: res.headers.get("x-agent-games-signature") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: SECRET, KURIER_API_KEY, SEEN_STORE_PATH: SEEN };
  const srv = spawn("node", [path.join(__dirname, "..", "src", "local-server.js")], { env, stdio: "pipe" });
  srv.stdout.on("data", (d) => process.stdout.write("[srv] " + d));
  srv.stderr.on("data", (d) => process.stdout.write("[srv:err] " + d));
  try {
    let up = false;
    for (let i = 0; i < 30; i++) {
      try { const r = await fetch(BASE + "/agent"); if (r.ok) { up = true; break; } } catch {}
      await sleep(500);
    }
    if (!up) throw new Error("server did not come up");
    console.log("server up");

    const pf = await post("/agent", { type: "agent-games.preflight.v1", agent_id: "live-test", issued_at: new Date().toISOString(), nonce: "live1" });
    console.log("preflight:", pf.status, pf.text.slice(0, 120), "signed:", !!pf.sig);

    const fakeTx = "0x" + "ab".repeat(32);
    const now = Math.floor(Date.now() / 1000);
    const task = {
      type: "agent-games.proof-gatekeeper.v1",
      task_id: "gk_live_" + now,
      mode: "competition",
      issued_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + 55000).toISOString(),
      input: {
        registered_vk: VK_HASH, proof_vk: VK_HASH, minimum: 1000, public_balance: 1460,
        expiry_block: 8430000, current_block: 8420000,
        recipient: "0xDe42000000000000000000000000000000009f01",
        condition_recipient: "0xDe42000000000000000000000000000000009f01",
        amount: 500, max_transfer: 1000, proof_tx: fakeTx,
      },
    };
    const t0 = Date.now();
    const r = await post("/agent", task);
    const ms = Date.now() - t0;
    console.log("task:", r.status, `(${ms} ms)`, "signed:", !!r.sig);
    const j = JSON.parse(r.text);
    console.log("decision:", j.decision, "| reason:", j.reason_code, "| proof:", !!j.proof, "| public_signals:", (j.public_signals || []).length);
    console.log("proof_tx:", j.proof_tx);
    console.log("kurier_submitted:", j.proof_tx && j.proof_tx !== fakeTx ? "YES (txHash differs from input echo)" : "NO (echoed input proof_tx)");
  } finally {
    srv.kill("SIGTERM");
  }
})().catch((e) => { console.error("LIVE TEST FAILED:", e.message); process.exit(1); });
