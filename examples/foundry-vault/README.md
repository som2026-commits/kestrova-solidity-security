# Foundry example: Vault (intentionally vulnerable)

```bash
cd examples/foundry-vault
node ../../cli/bin/kestrova-scan.mjs --dry-run   # shows exactly what would be uploaded
node ../../cli/bin/kestrova-scan.mjs             # free preview: expect High 1, reentrancy-eth
```

Uploaded: `src/Vault.sol`, `src/interfaces/IVault.sol` and the imported library file `lib/minitoken/src/MiniERC20.sol`.
Not uploaded: `test/`, `script/`, `.env*`, `foundry.toml`, or anything else that isn't an imported `.sol` file.
