# Agent Games — Proof Gatekeeper Agent

An HTTPS agent endpoint for the **Proof Gatekeeper** event in the zkVerify
Agent Games (Season 01, 21 Oct – 21 Nov 2026). The platform POSTs signed task
envelopes; this service verifies the HMAC, makes a deterministic APPROVE /
REJECT decision, generates a real Groth16 proof locally with snarkjs against
the official gatekeeper circuit, optionally submits it to zkVerify via
Kurier, and returns a signed response — well inside the 60-second hard
deadline (typical end-to-end: ~1.6 s).

Built for @fngyuan24 (Agent Games handle `dhanikisworo`).

## Protocol (from https://agentgames.zkverify.io/build)

```
POST /agent
  ├─ 1. HMAC-SHA256 over the RAW body vs `x-agent-games-signature`
  │     (verified BEFORE JSON parsing; mismatch → HTTP 401)
  ├─ 2. type = "agent-games.preflight.v1"
  │     → signed `{ ok: true, protocolVersion: "v1" }`
  └─ 3. type = "agent-games.proof-gatekeeper.v1"
        ├─ idempotency cache (same task_id → cached response)
        ├─ deadline/timestamp sanity → fail closed
        ├─ deterministic policy (src/decision.js) → decision + reason_code
        ├─ snarkjs fullProve with gatekeeper.wasm / gatekeeper_final.zkey
        │    (skipped only for PROOF_REUSED — documented as having no proof)
        ├─ Kurier submit + bounded poll (≤15 s) → on-chain txHash as proof_tx
        └─ signed JSON response
```

Fail-closed throughout: malformed envelopes, internal errors, and proof
generation failures all resolve to REJECT, never to an unproven APPROVE.

Decision rules (trap taxonomy from `/events/proof-gatekeeper`):

| Check | Result |
|---|---|
| proof_vk != registered_vk | REJECT `VK_SUBSTITUTION` |
| proof_tx already seen | REJECT `PROOF_REUSED` (no proof) |
| public_balance < minimum | REJECT `THRESHOLD_MISMATCH` |
| current_block >= expiry_block | REJECT `EXPIRED_CONDITION` |
| recipient != condition_recipient | REJECT `RECIPIENT_MISMATCH` |
| amount > max_transfer | REJECT `AMOUNT_OVERFLOW` |
| all checks pass | APPROVE `VALID_CONDITION` |

## Layout

| Path | Purpose |
|---|---|
| `api/agent.js` | Vercel serverless entry (raw body for HMAC). |
| `src/local-server.js` | Plain Node HTTP server (`npm start`). |
| `src/handler.js` | Framework-agnostic request pipeline. |
| `src/hmac.js` | HMAC sign/verify + per-task circuit salt derivation. |
| `src/decision.js` | Deterministic policy + envelope→circuit field conversion. |
| `src/prover.js` | snarkjs `groth16.fullProve` wrapper. |
| `src/kurier.js` | Kurier submit-proof + job-status polling (never throws). |
| `src/seenStore.js` | proof_tx seen-set + response cache, JSON-file backed. |
| `circuits/` | Official `gatekeeper.wasm`, `gatekeeper_final.zkey`, `gatekeeper-vk.json`. |
| `test/harness.js` | Local end-to-end harness (`npm test`). |

## Run locally

```sh
npm install
cp .env.example .env   # fill in AGENT_GAMES_HMAC_SECRET (+ KURIER_API_KEY)
npm test               # 19 checks: preflight, HMAC, approve + 6 traps, reuse
npm start              # listens on :8787 (POST /agent)
```

## Deploy (Vercel)

```sh
vercel --prod
vercel env add AGENT_GAMES_HMAC_SECRET production
vercel env add KURIER_API_KEY production
```

Then in the Agent Games dashboard: register the endpoint URL
(`https://<deployment>/agent`), rotate the secret, run preflight, and
complete at least one practice task before the scored round opens.

## Notes

- The gatekeeper circuit's input signal names are not published on the
  /build page; they were recovered by probing the compiled WASM and
  confirmed by proving: `taskId, registeredVkHash, proofVkHash, minimum,
  publicBalance, expiryBlock, currentBlock, recipient, conditionRecipient,
  amount, maxTransfer, decision, salt (private)`. Public signals order:
  `[commitment, registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, taskId]`, where `commitment = Poseidon(taskId, salt)`.
- `taskId` is encoded as `SHA-256(task_id) mod p`; hex values (vk hashes,
  addresses) are reduced mod the BN128 prime — reduction preserves the
  equality checks the circuit performs.
- No secret is ever committed: `.env` and `data/` are gitignored.
