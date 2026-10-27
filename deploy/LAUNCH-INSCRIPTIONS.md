# Operator launch inscriptions

The periodic table starts empty. There are no starter patterns or operator-funded element or token deployments.

The operator's only launch inscription is the committee-signed `privilege-auth`, followed by its self-send activation:

1. Run the prepared launch flow. It writes the exact `privilege-authority` text and receiver address to the private `owner-inscriptions.json` output. The committee generates its salt and signature; do not replace them with placeholders.
2. In Tap Wallet, inscribe that exact text into **your own Tap Wallet address**, then **send that inscription to the same address**. This second transaction activates the authority. You pay both Bitcoin transaction fees.
3. Record its public inscription ID under `privilege-authority` in `runtime.ownerInscriptionsFile` and resume after one confirmation. The launcher verifies the content, receiver and indexed activation before continuing.

For an offline copy of the same bundle, supply a JSON object containing `authority` (the complete public committee-signed privilege-auth object, not an inscription ID) and `receiver` (your Tap Wallet address):

```sh
node deploy/launch-inscriptions.mjs --input /absolute/private/public-authority.json --out /absolute/private/owner-inscriptions.json
```

The generator writes one exact inscription text and its self-send instructions. It makes no network requests, signatures or broadcasts. The launch reader still independently verifies the indexed inscription and activation.

An agent discovers the first pattern. Its first minter pays for and inscribes the exact `name.pat.fld.element` text supplied by `/mint/deployment/ASSET`. An already indexed element with the same `(pat,fld)` is reused. After element confirmation, the service supplies exact `dmt-deploy` JSON with that element ID, its allocated ticker and the committee authority as `prv`. The minter inscribes it from the same wallet and submits each phase to `/mint/deployment`. Occupied element names and tickers receive replacements. No mint permit is available until the indexed definition and authority have been verified.

Compounds follow the same player-funded deployment flow with `token-deploy`, `max: "18446744073709551615"`, and `dec: "0"`; their first maker supplies that inscription. The operator does not deploy either kind of player asset at launch.
