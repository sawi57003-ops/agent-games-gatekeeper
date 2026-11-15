// Kurier (zkVerify) proof submission — mainnet.
//
// Shape from the /build page and docs.zkverify.io:
//   POST {KURIER_API_URL}/submit-proof/{KURIER_API_KEY}
//   { proofType: "groth16", vkRegistered: true,
//     proofOptions: { library: "snarkjs", curve: "bn128" },
//     proofData: { proof, publicSignals, vk: <vk_hash> } }
//   -> { jobId, optimisticVerify }
//   GET {KURIER_API_URL}/job-status/{KURIER_API_KEY}/{jobId}
//   lifecycle: Queued -> Valid -> Submitted -> IncludedInBlock -> Finalized | Failed
//   The txHash is present once the extrinsic is on-chain; polling returns as
//   soon as a txHash is known instead of blocking the task response on
//   finalization; the Kurier job keeps finalizing server-side regardless.
//
// The gatekeeper vk_hash is already registered on mainnet, so
// vkRegistered: true and no register-vk call is needed.
//
// HARD RULE (learned live 15 Nov 2026): every HTTP call here has its own
// AbortSignal timeout. A hung fetch without a timeout blew a live task to
// 88 s — past the platform's 60 s hard deadline — even though the poll
// budget was 15 s. No single request may ever exceed its timeout, and the
// whole submission must fit inside the caller's budget.
//
// This module never throws: any failure returns null / a non-final status and
// the caller still answers the task with the proof + public_signals.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-request ceilings. Submit waits for Kurier's optimistic verification,
// which is the slowest step; status polls are cheap reads.
const SUBMIT_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5_000;

async function fetchJson(url, options, timeoutMs) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function submitProofAndPoll(cfg, proof, publicSignals, budgetMs) {
  if (!cfg.kurierApiKey) {
    console.log("[kurier] KURIER_API_KEY not set — skipping zkVerify submission");
    return null;
  }
  const key = cfg.kurierApiKey;
  const deadline = Date.now() + Math.max(0, budgetMs);
  const t0 = Date.now();
  try {
    const job = await fetchJson(
      `${cfg.kurierApiUrl}/submit-proof/${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proofType: "groth16",
          vkRegistered: true,
          proofOptions: { library: "snarkjs", curve: "bn128" },
          proofData: { proof, publicSignals, vk: cfg.gatekeeperVkHash },
        }),
      },
      Math.min(SUBMIT_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
    );
    if (!job.jobId) {
      console.error("[kurier] submit-proof response missing jobId");
      return null;
    }
    console.log(
      `[kurier] job ${job.jobId} submitted in ${Date.now() - t0} ms (optimisticVerify=${job.optimisticVerify ?? "n/a"})`,
    );

    let status = "Submitted";
    let lastTxHash;
    while (Date.now() < deadline) {
      await sleep(Math.min(cfg.kurierPollIntervalMs, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      let s;
      try {
        s = await fetchJson(
          `${cfg.kurierApiUrl}/job-status/${key}/${job.jobId}`,
          {},
          Math.min(STATUS_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
        );
      } catch (err) {
        console.error(`[kurier] job-status error: ${err.message}`);
        continue;
      }
      status = s.status ?? status;
      const txHash = s.txHash ?? s.transactionInfo?.txHash;
      if (txHash) lastTxHash = txHash;
      if (status === "Failed") {
        return { jobId: job.jobId, status, txHash, finalized: false };
      }
      if (txHash) {
        // The on-chain transaction exists; return its hash now and let
        // finalization complete server-side at Kurier.
        return { jobId: job.jobId, status, txHash, finalized: status === "Finalized" };
      }
    }
    console.log(`[kurier] job ${job.jobId} produced no txHash within budget (last status=${status})`);
    return { jobId: job.jobId, status, txHash: lastTxHash, finalized: false };
  } catch (err) {
    console.error("[kurier] submission error:", err.message);
    return null;
  }
}

module.exports = { submitProofAndPoll };
