# Privacy nudges demo

A static page that runs `checkPrivacy()` against nine example wallets and shows each result as a
confirm screen: the privacy level, the warnings, and the suggested fix.

```sh
npm run example:privacy                       # bundles src/privacy into ./privacy.js
npx serve examples/privacy-nudges             # or any static server
```

All demo data is made up. The checks run in the browser; nothing is sent anywhere.
