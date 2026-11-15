// Local Groth16 proving with snarkjs fullProve against the downloaded
// gatekeeper artifacts. Measured on this VM at ~2.3 s per proof for this
// circuit (647 witnesses), comfortably inside the 60 s task deadline.
const path = require("path");
const snarkjs = require("snarkjs");

class Prover {
  constructor(circuitsDir) {
    this.wasmPath = path.join(circuitsDir, "gatekeeper.wasm");
    this.zkeyPath = path.join(circuitsDir, "gatekeeper_final.zkey");
  }

  async prove(circuitInputs) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      this.wasmPath,
      this.zkeyPath,
    );
    return { proof, publicSignals };
  }
}

module.exports = { Prover };
