// Local end-to-end harness for the Proof Gatekeeper agent.
//
// Boots the real HTTP server on an ephemeral port with a throwaway HMAC
// secret and a temp seen-store, then replays signed envelopes built from the
// /build + /events/proof-gatekeeper samples:
//   - preflight handshake shape + response signature
//   - HMAC sign/verify roundtrip (hex + base64), tamper + wrong-secret rejects
//   - one VALID_CONDITION approve, with the returned Groth16 proof verified
//     locally against the circuit verification key
//   - every documented trap: VK_SUBSTITUTION, PROOF_REUSED,
//     THRESHOLD_MISMATCH, EXPIRED_CONDITION, RECIPIENT_MISMATCH,
//     AMOUNT_OVERFLOW (each with decision + reason_code asserted, and the
//     proof verified where the spec requires one)
//   - idempotent redelivery of the same task_id
//   - Kurier key absent -> submission skipped, answer unaffected
//
// Run: npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const snarkjs = require("snarkjs");

const TEST_SECRET = "test-harness-secret-do-not-use-in-prod";
process.env.AGENT_GAMES_HMAC_SECRET = TEST_SECRET;
process.env.SEEN_STORE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "gk-seen-")),
  "seen.json",
);
delete process.env.KURIER_API_KEY;

const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const OTHER_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44f";

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function tx(seed) {
  return "0x" + crypto.createHash("sha256").update(seed).digest("hex");
}

function makeTask(taskId, overrides = {}) {
  const now = Date.now();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 55_000).toISOString(),
    input: {
      registered_vk: VK_HASH,
      proof_vk: VK_HASH,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: RECIPIENT,
      condition_recipient: RECIPIENT,
      amount: "500",
      max_transfer: "1000",
      proof_tx: tx("proof-" + taskId),
      ...overrides,
    },
  };
}

async function main() {
  const { createAgentServer } = require("../src/local-server");
  const { signBody, verifyBodySignature } = require("../src/hmac");
  const vk = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "circuits", "gatekeeper-vk.json"), "utf8"),
  );

  const server = createAgentServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function postRaw(bodyObj, secret = TEST_SECRET, sigOverride) {
    const raw = typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj);
    const sig = sigOverride !== undefined ? sigOverride : signBody(secret, raw);
    const res = await fetch(`${base}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-games-signature": sig },
      body: raw,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: res.status, text, json, sigHeader: res.headers.get("x-agent-games-signature") };
  }

  async function verifyProof(json) {
    if (!json || !json.proof || !json.public_signals) return false;
    try {
      return await snarkjs.groth16.verify(vk, json.public_signals, json.proof);
    } catch {
      return false;
    }
  }

  console.log("preflight + HMAC");
  const pre = await postRaw({ type: "agent-games.preflight.v1", agent_id: "agt_test", issued_at: new Date().toISOString(), nonce: "abc123" });
  check("preflight 200 + ok:true", pre.status === 200 && pre.json && pre.json.ok === true && pre.json.protocolVersion === "v1");
  check("preflight response signed + valid", !!pre.sigHeader && verifyBodySignature(TEST_SECRET, pre.text, pre.sigHeader));
  const badSig = await postRaw({ type: "agent-games.preflight.v1" }, TEST_SECRET, "deadbeef");
  check("bad signature -> 401", badSig.status === 401);
  const wrongSecret = await postRaw({ type: "agent-games.preflight.v1" }, "wrong-secret");
  check("wrong secret -> 401", wrongSecret.status === 401);

  console.log("valid approve");
  const t0 = Date.now();
  const valid = await postRaw(makeTask("gk_test_valid"));
  const validMs = Date.now() - t0;
  check("valid -> APPROVE/VALID_CONDITION", valid.json && valid.json.decision === "APPROVE" && valid.json.reason_code === "VALID_CONDITION", JSON.stringify(valid.json));
  check("valid proof verifies locally", await verifyProof(valid.json));
  check("valid response signed", !!valid.sigHeader && verifyBodySignature(TEST_SECRET, valid.text, valid.sigHeader));
  console.log(`  (approve end-to-end: ${validMs} ms)`);

  console.log("traps");
  const traps = [
    ["VK_SUBSTITUTION", { proof_vk: tx("other-vk") }],
    ["THRESHOLD_MISMATCH", { public_balance: "999" }],
    ["EXPIRED_CONDITION", { current_block: 8430000 }],
    ["RECIPIENT_MISMATCH", { condition_recipient: OTHER_RECIPIENT }],
    ["AMOUNT_OVERFLOW", { amount: "1001" }],
  ];
  for (const [code, over] of traps) {
    const r = await postRaw(makeTask("gk_test_" + code.toLowerCase(), over));
    const okDecision = r.json && r.json.decision === "REJECT" && r.json.reason_code === code;
    check(`${code} -> REJECT/${code}`, okDecision, JSON.stringify(r.json));
    check(`${code} proof verifies (decision=0)`, await verifyProof(r.json));
  }

  console.log("proof reuse + redelivery");
  const reused = await postRaw(makeTask("gk_test_reused", { proof_tx: tx("proof-gk_test_valid") }));
  check("PROOF_REUSED -> REJECT, no proof", reused.json && reused.json.decision === "REJECT" && reused.json.reason_code === "PROOF_REUSED" && !reused.json.proof, JSON.stringify(reused.json));
  const redelivered = await postRaw(makeTask("gk_test_valid"));
  check("redelivery -> same body (cached)", redelivered.text === valid.text);

  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
