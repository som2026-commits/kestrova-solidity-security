// Solana Agent Kit plugin. Usage:
//   import { z } from "zod";
//   import { createKestrovaPlugin } from "./solana-agent-kit.mjs";
//   const agent = new SolanaAgentKit(wallet, rpcUrl, config).use(createKestrovaPlugin({ z },
//       { paymentFetch /* optional: x402-wrapped fetch using YOUR Solana wallet */, maxPaymentUsd: 0.05 }));
//   await agent.methods.kestrovaContractRiskPreview({ chain: "base", address: "0x..." });
// Without paymentFetch + maxPaymentUsd the paid actions only report the price; nothing is ever paid.
import { CHAINS, DESCRIPTIONS, contractRiskCheck, contractRiskPreview, solidityHighlights, solidityPreview } from "./core.mjs";

export function createKestrovaPlugin({ z }, opts = {}) {
  const o = { ...opts, tag: "solana-agent-kit" };
  const target = z.object({ chain: z.enum(CHAINS), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
  const sources = z.object({ sources: z.record(z.string(), z.string()) });
  const methods = {
    kestrovaContractRiskPreview: (input) => contractRiskPreview(target.parse(input), o),
    kestrovaContractRiskCheck: (input) => contractRiskCheck(target.parse(input), o),
    kestrovaSolidityPreview: (input) => solidityPreview(sources.parse(input), o),
    kestrovaSolidityHighlights: (input) => solidityHighlights(sources.parse(input), o),
  };
  const example = { chain: "base", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" };
  const action = (name, description, schema, method, similes, input, output) => ({
    name, similes, description, schema,
    examples: [[{ input, output, explanation: description.split(".")[0] }]],
    handler: async (_agent, inp) => {
      try { return { status: "success", result: await methods[method](inp) }; }
      catch (e) { return { status: "error", message: e.message }; }
    },
  });
  return {
    name: "kestrova",
    methods,
    actions: [
      action("KESTROVA_CONTRACT_RISK_PREVIEW", DESCRIPTIONS.riskPreview, target, "kestrovaContractRiskPreview",
             ["is this contract safe", "check contract before buying", "contract privileges"], example,
             { verified: true, proxy: { isProxy: true }, privileges: [{ kind: "pause" }] }),
      action("KESTROVA_CONTRACT_RISK_CHECK", DESCRIPTIONS.riskCheck, target, "kestrovaContractRiskCheck",
             ["contract risk verdict", "is this token a honeypot"], example, { paid: true, result: { verdict: "medium" } }),
      action("KESTROVA_SOLIDITY_PREVIEW", DESCRIPTIONS.solidityPreview, sources, "kestrovaSolidityPreview",
             ["scan my solidity", "check contract source"], { sources: { "A.sol": "pragma solidity ^0.8.20; contract A {}" } },
             { counts: { Informational: 1 }, detectors: [] }),
      action("KESTROVA_SOLIDITY_HIGHLIGHTS", DESCRIPTIONS.solidityHighlights, sources, "kestrovaSolidityHighlights",
             ["solidity findings with lines"], { sources: { "A.sol": "pragma solidity ^0.8.20; contract A {}" } },
             { paid: true, result: { findings: [] } }),
    ],
    initialize() { /* no state, no keys */ },
  };
}
