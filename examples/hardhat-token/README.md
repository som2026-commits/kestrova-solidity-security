# Hardhat example: RewardToken (intentionally vulnerable)

```bash
cd examples/hardhat-token
npm install                      # installs hardhat and @openzeppelin/contracts
npx kestrova-scan --dry-run      # or: node ../../cli/bin/kestrova-scan.mjs --dry-run
npm run kestrova                 # free preview
```

Uploaded: `contracts/RewardToken.sol` plus only the OpenZeppelin files it imports (about 6 files). Nothing else
from `node_modules` is uploaded.
