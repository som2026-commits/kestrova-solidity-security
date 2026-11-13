# Kestrova for autonomous agents: Coinbase AgentKit and Solana Agent Kit

These are drop-in actions for agents that touch smart contracts. They use each framework's public extension API and
are **not official integrations** of Coinbase or SendAI. Automated analysis, **not an audit**.

> **Availability (November 2026):** only `kestrova_solidity_preview` works against the live service
> (`https://kestrova-api.onrender.com`). The other three actions call endpoints (`/risk/address/preview`,
> `/risk/address`, `/scan/highlights`) that are **not deployed**: they return an error and never charge. For a paid
> line-level report today, use `POST /scan` (1 USDC via x402, Base or Solana).

| Action | Cost | Use it |
|---|---|---|
| `kestrova_contract_risk_preview` | Free (rate-limited) | Before interacting with a contract: verified? proxy? which privileged controls (mint, pause, blacklist, fee/limit setters, upgrade, owner/roles)? |
| `kestrova_contract_risk_check` | **0.05 USDC** (x402) | An explained `high` / `medium` / `low` verdict from verified source, proxy implementation, privileged controls and Slither findings. Unverified contracts are **not charged** |
| `kestrova_solidity_preview` | Free | Severity counts and High/Medium detector names for Solidity the agent wrote |
| `kestrova_solidity_highlights` | **0.10 USDC** (x402) | High/Medium findings with file and lines |

Supported contract chains: ethereum, base, arbitrum, optimism, polygon, bsc, avalanche, linea, scroll, sepolia and
base-sepolia. Contract source comes from Sourcify.

## Payments are off unless you turn them on

- Paid actions only pay when you pass **both** of these:
  - `paymentFetch`: a `fetch` wrapped by **your own** x402 client and wallet;
  - `maxPaymentUsd`: a spending cap.
- Before paying, the price in the server's 402 offer is checked against the cap, and **every** offered rail must fit
  it.
- Without both, the action returns the price and how to enable payment. **Nothing is paid.**
- A failed paid call (for example an unverified contract or the service being unavailable) isn't charged and is never
  retried automatically. If an outcome is unclear, it returns the recovery endpoint instead.
- These modules never hold keys and never sign.

## Coinbase AgentKit

```js
import { AgentKit, customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import { createKestrovaActionProvider } from "./integrations/agent-frameworks/agentkit.mjs";

const kestrova = createKestrovaActionProvider({ customActionProvider, z }, {
  // optional, to allow the paid actions:
  // paymentFetch: wrapFetchWithPayment(fetch, yourWalletAccount),   // your x402 client
  // maxPaymentUsd: 0.05,
});
const agentkit = await AgentKit.from({ walletProvider, actionProviders: [kestrova /*, ...*/] });
```

This was tested with `@coinbase/agentkit` 0.10.4 and zod 3: four actions register, the schemas validate, and the
actions run.

**Note:** AgentKit itself sends an analytics event to Coinbase on every action invocation. That is AgentKit's
behaviour; Kestrova's code sends no telemetry.

## Solana Agent Kit

```js
import { SolanaAgentKit } from "solana-agent-kit";
import { z } from "zod";
import { createKestrovaPlugin } from "./integrations/agent-frameworks/solana-agent-kit.mjs";

const agent = new SolanaAgentKit(wallet, rpcUrl, config).use(createKestrovaPlugin({ z }, {
  // paymentFetch, maxPaymentUsd: 0.05   // optional; pays in USDC through your own x402 client
}));
const preview = await agent.methods.kestrovaContractRiskPreview({ chain: "base", address: "0x..." });
```

The plugin follows the `Plugin` and `Action` interfaces of `solana-agent-kit` 2.0.10 (`name`, `methods`, `actions`
with `similes`/`examples`/`schema`/`handler`, `initialize`).

## Example agent policy

> Before approving, buying or depositing into a contract you have not used before, call
> `kestrova_contract_risk_preview`. If it is unverified, upgradeable, or has blacklist or fee controls, call
> `kestrova_contract_risk_check` (0.05 USDC, within the configured cap) and do not proceed on a `high` verdict without
> the user's confirmation.
