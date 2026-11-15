// Vercel serverless entry for the Proof Gatekeeper agent.
// Reads the RAW request body (required for HMAC verification) and delegates
// to the shared AgentHandler. No framework, no build step.
const { loadConfig } = require("../src/config");
const { AgentHandler, SIGNATURE_HEADER } = require("../src/handler");
const { SeenStore } = require("../src/seenStore");

const MAX_BODY_BYTES = 1_048_576;

let handlerPromise = null;
function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const cfg = loadConfig();
      return new AgentHandler(cfg, new SeenStore(cfg.seenStorePath));
    })();
  }
  return handlerPromise;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const handler = await getHandler();

  if (req.method === "GET") {
    const r = handler.health();
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
    return;
  }

  if (req.method === "POST") {
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
    const signature = req.headers[SIGNATURE_HEADER];
    const result = await handler.handlePost(
      rawBody,
      Array.isArray(signature) ? signature[0] : signature,
    );
    const headers = { "content-type": "application/json" };
    if (result.signature) headers[SIGNATURE_HEADER] = result.signature;
    res.writeHead(result.status, headers);
    res.end(result.body);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
};
