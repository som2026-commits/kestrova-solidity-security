// `kestrova-scan --setup [client]`: prints the exact, documented way to connect Kestrova's remote MCP server to an AI
// coding agent. It only PRINTS: it never edits a config file, installs anything or contacts the network.
const MCP = "https://kestrova.onrender.com/mcp";
const url = (src) => `${MCP}?src=${src}`;
const b64 = (s) => Buffer.from(s).toString("base64");

const RULE = `After a meaningful batch of Solidity changes, suggest ONE Kestrova check (not on every edit). With a shell,
run \`npx kestrova-scan --changed\` (or \`--staged\` before a commit); otherwise call the kestrova MCP tool
scan_solidity_preview with the changed contract and every file it imports. Never call scan_solidity_full (paid,
1 USDC) unless the user explicitly approves that payment. Automated analysis, not an audit.`;

export const CLIENTS = {
  claude: {
    title: "Claude Code",
    steps: () => [
      `claude mcp add --transport http kestrova "${url("claude")}"`,
      "claude mcp list        # expect: kestrova ... Connected",
    ],
    file: () => ({ path: ".mcp.json (project scope, commit it for your team)",
                   body: JSON.stringify({ mcpServers: { kestrova: { type: "http", url: url("claude") } } }, null, 2) }),
    note: "Optional skill: add the rule below to CLAUDE.md, or install the plugin bundled in this package (see README).",
  },
  cursor: {
    title: "Cursor",
    steps: () => [
      "One-click (opens Cursor's MCP install dialog):",
      `cursor://anysphere.cursor-deeplink/mcp/install?name=kestrova&config=${b64(JSON.stringify({ url: url("cursor") }))}`,
    ],
    file: () => ({ path: "~/.cursor/mcp.json (all projects) or .cursor/mcp.json (this project)",
                   body: JSON.stringify({ mcpServers: { kestrova: { url: url("cursor") } } }, null, 2) }),
    note: "Optional: save the rule below as .cursor/rules/solidity-security.mdc with globs [\"**/*.sol\"].",
  },
  vscode: {
    title: "VS Code (GitHub Copilot agent mode)",
    steps: () => [`code --add-mcp '${JSON.stringify({ name: "kestrova", type: "http", url: url("vscode") })}'`],
    file: () => ({ path: ".vscode/mcp.json",
                   body: JSON.stringify({ servers: { kestrova: { type: "http", url: url("vscode") } } }, null, 2) }),
    note: "Optional: add the rule below to .github/copilot-instructions.md.",
  },
  codex: {
    title: "OpenAI Codex CLI",
    steps: () => [`codex mcp add kestrova --url "${url("codex")}"`, "codex mcp list"],
    file: () => ({ path: "~/.codex/config.toml", body: `[mcp_servers.kestrova]\nurl = "${url("codex")}"` }),
    note: "Optional: add the rule below to AGENTS.md in your repository.",
  },
  gemini: {
    title: "Gemini CLI",
    steps: () => ["Add the block below to ~/.gemini/settings.json (or .gemini/settings.json in the project)."],
    file: () => ({ path: "~/.gemini/settings.json",
                   body: JSON.stringify({ mcpServers: { kestrova: { httpUrl: url("gemini") } } }, null, 2) }),
    note: "Optional: add the rule below to GEMINI.md.",
  },
  generic: {
    title: "Any MCP client (Streamable HTTP, no auth)",
    steps: () => [`URL: ${url("mcp")}`, "Tools: scan_solidity_preview (free), payment_terms (free), scan_solidity_full (1 USDC, x402)"],
    file: () => null,
    note: "No API key or account. The paid tool needs an x402-capable wallet client and the user's approval.",
  },
};

export function setupText(client) {
  if (!client) {
    return ["Connect Kestrova to your coding agent. Pick one:",
            ...Object.entries(CLIENTS).map(([k, c]) => `  kestrova-scan --setup ${k.padEnd(8)} ${c.title}`),
            "", "Nothing is installed or edited: each command only prints the steps."].join("\n");
  }
  const c = CLIENTS[client];
  if (!c) throw new Error(`unknown client "${client}" (choose: ${Object.keys(CLIENTS).join(", ")})`);
  const lines = [`# Kestrova for ${c.title}`, "", ...c.steps()];
  const f = c.file();
  if (f) lines.push("", `Or add to ${f.path}:`, f.body);
  lines.push("", c.note, "", "Rule for the agent:", RULE, "",
             "Free preview: severity counts and High/Medium detector names. Not an audit.");
  return lines.join("\n");
}
