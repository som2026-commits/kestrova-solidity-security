// Coinbase AgentKit adapter (custom action provider). Usage:
//   import { customActionProvider } from "@coinbase/agentkit";
//   import { z } from "zod";
//   import { createKestrovaActionProvider } from "./agentkit.mjs";
//   const kestrova = createKestrovaActionProvider({ customActionProvider, z },
//       { paymentFetch /* optional: x402-wrapped fetch using YOUR wallet */, maxPaymentUsd: 0.05 /* optional cap */ });
//   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [kestrova, ...] });
// Without paymentFetch + maxPaymentUsd the paid actions only report the price; nothing is ever paid.
import { CHAINS, DESCRIPTIONS, contractRiskCheck, contractRiskPreview, solidityHighlights, solidityPreview } from "./core.mjs";

export function createKestrovaActionProvider({ customActionProvider, z }, opts = {}) {
  const o = { ...opts, tag: "agentkit" };
  const target = z.object({
    chain: z.enum(CHAINS).describe("chain the contract is deployed on"),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("contract address"),
  });
  const sources = z.object({ sources: z.record(z.string(), z.string()).describe("map of file name (*.sol) to Solidity source, including imports") });
  const asText = (v) => JSON.stringify(v);
  return customActionProvider([
    { name: "kestrova_contract_risk_preview", description: DESCRIPTIONS.riskPreview, schema: target,
      invoke: async (args) => asText(await contractRiskPreview(args, o)) },
    { name: "kestrova_contract_risk_check", description: DESCRIPTIONS.riskCheck, schema: target,
      invoke: async (args) => asText(await contractRiskCheck(args, o)) },
    { name: "kestrova_solidity_preview", description: DESCRIPTIONS.solidityPreview, schema: sources,
      invoke: async (args) => asText(await solidityPreview(args, o)) },
    { name: "kestrova_solidity_highlights", description: DESCRIPTIONS.solidityHighlights, schema: sources,
      invoke: async (args) => asText(await solidityHighlights(args, o)) },
  ]);
}
