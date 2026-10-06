# Privacy nudges

Most privacy leaks in shielded pools come from how people use them, not from the cryptography. In
Privacy Pools v1, 14.4% of users withdrew to the address they deposited from, 9.8% used amounts
that could be fingerprinted, and 8.3% withdrew within 5 minutes.

`checkPrivacy` looks at what the user is about to do, compares it with their own history, and
returns warnings with a suggested fix. Show them before the user confirms.

- **It never blocks.** Anyone can use the pool, so the user can always go ahead.
- **It runs on the device.** It reads the wallet's local history and makes no network calls.
  Nothing about the user's activity is sent to Armada or to your app's servers.
- **The copy is a default.** Every warning returns its text as data, so you can restyle or reword it.

## Run a check

```ts
import { checkPrivacy } from '@armada/sdk';

const report = checkPrivacy(
  { kind: 'unshield', amount: 12_480_000_000n, recipient: '0x…', submittedBy: 'relayer' },
  {
    history: await wallet.history(),
    now: Math.floor(Date.now() / 1000),
    depositAddresses: ['0x…'],               // addresses this wallet has shielded from
    poolActivity: { recentActions24h: 37 },  // optional, from public pool events
    network: { tor: false, privateRpc: true },
  },
);

report.level;    // 'good' | 'fair' | 'weak'
report.warnings; // [{ id, level, title, body, fix }]
```

Show `report.level` as a short label on the confirm screen, for example "Privacy: fair", not as a
score out of 100.

| Level | Meaning |
|---|---|
| `good` | Nothing above an info note. |
| `fair` | One warning, or an amount that stands out. |
| `weak` | A strong warning, or two or more warnings. |

## The checks

| Check | Level | Fires when | Fix |
|---|---|---|---|
| `no-relayer` | strong | The user submits a spend themselves | `use-relayer` |
| `same-address` | strong | An unshield goes to an address the wallet deposited from | `fresh-address` |
| `same-amount` | strong | An unshield is within 1% of a deposit (allowing for the shield and relayer fees) | `split` |
| `quick-exit` | warn | An unshield comes less than 24 hours after the latest deposit | `delay` |
| `quiet-pool` | warn | Fewer than 20 shields and transfers in the last 24 hours | `remind` |
| `distinctive-amount` | info | The amount has cents, or is over `largeAmount` | `change-amount` or `split` |
| `regular-pattern` | warn | The 3rd or later unshield of a similar size or to the same recipient | `pay-in-pool` |
| `cross-chain-public` | info | Any cross-chain shield or unshield | `learn-more` |
| `yield-match` | info | A yield withdrawal within 2% of a lend made in the last 3 days | `delay` |
| `viewing-key-share` | strong | Always, when sharing a viewing key | `type-to-confirm` |
| `network` | info | The app reports no Tor and no private RPC | `network-settings` |

Every threshold can be changed through `thresholds`, for example
`{ quickExitSeconds: 172_800, largeAmount: 100_000_000_000n }`.

## Fixes

A fix tells your app what to offer instead:

- `split` comes with `parts`, uneven amounts that add up to the original. Submit them as separate unshields.
- `delay` comes with `notBefore`, a unix time to wait until. `remind` comes with `at`.
- `change-amount` comes with a `suggested` round amount.
- `type-to-confirm` comes with the `phrase` the user has to type.

The other fixes (`use-relayer`, `fresh-address`, `pay-in-pool`, `network-settings`, `learn-more`)
point to a screen or setting in your app.
