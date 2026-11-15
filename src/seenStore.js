// Seen-set for proof_tx references ("The proof reference has not already been
// used for another task" — /build Security checklist; PROOF_REUSED trap).
//
// In-memory Sets are authoritative for the life of the process; a JSON file
// backs them across restarts (best-effort: on serverless the file lives in
// /tmp and may vanish on cold start).
//
// Two maps are kept:
//   proofTx -> task_id   (reuse detection: the same proof_tx from a DIFFERENT
//                         task_id is a trap; the same task_id redelivered is
//                         NOT reuse — it is answered from the response cache,
//                         or re-evaluated with the reuse check skipped)
//   task_id -> serialized response (idempotent redelivery)
const fs = require("fs");
const path = require("path");

function normalizeTx(tx) {
  return (tx ?? "").trim().toLowerCase();
}

class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.proofTxToTask = new Map();
    this.responseByTaskId = new Map();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      for (const [tx, taskId] of Object.entries(data.proofTx ?? {})) {
        this.proofTxToTask.set(normalizeTx(tx), taskId);
      }
      for (const [k, v] of Object.entries(data.responses ?? {})) {
        this.responseByTaskId.set(k, v);
      }
    } catch {
      /* missing/corrupt file -> start empty */
    }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          proofTx: Object.fromEntries(this.proofTxToTask),
          responses: Object.fromEntries(this.responseByTaskId),
        }),
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[seen-store] persist failed:", err.message);
    }
  }

  // True only when proofTx was used by a DIFFERENT task.
  hasProofTxFromOtherTask(proofTx, taskId) {
    const owner = this.proofTxToTask.get(normalizeTx(proofTx));
    return owner !== undefined && owner !== taskId;
  }

  recordProofTx(proofTx, taskId) {
    const key = normalizeTx(proofTx);
    if (!key) return;
    if (!this.proofTxToTask.has(key)) {
      this.proofTxToTask.set(key, taskId);
      this.persist();
    }
  }

  getResponse(taskId) {
    return this.responseByTaskId.get(taskId) ?? null;
  }

  recordResponse(taskId, serializedResponse) {
    if (!this.responseByTaskId.has(taskId)) {
      this.responseByTaskId.set(taskId, serializedResponse);
      this.persist();
    }
  }

  get size() {
    return this.proofTxToTask.size;
  }
}

module.exports = { SeenStore, normalizeTx };
