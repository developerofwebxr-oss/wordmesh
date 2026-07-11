# vendored deps

- `aepp-sdk.bundle.js` — @aeternity/aepp-sdk **14.1.1**, self-contained browser
  ESM bundle (esbuild `--bundle --format=esm --platform=browser --target=es2020`
  of `es/index-browser.js`). Committed so the Superhero Wallet connect never
  depends on a runtime CDN import (jsdelivr/esm.sh failed in some users'
  browsers). Rebuild: `npm i @aeternity/aepp-sdk@14.1.1 esbuild && esbuild
  node_modules/@aeternity/aepp-sdk/es/index-browser.js --bundle --format=esm
  --platform=browser --target=es2020 --outfile=vendor/aepp-sdk.bundle.js`.
