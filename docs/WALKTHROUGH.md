# Walkthrough

Two paths through this example. The first needs nothing but a checkout and reproduces byte for
byte. The second spends devnet funds and produces a real Solana transaction reference.

Read the [README](../README.md) first for what the example is and, more importantly, for what
verification does and does not establish.

## Prerequisites

- Node 22.13 or newer. Node 24 is what the primary continuous-integration job runs.
- Corepack, which ships with Node, so the pinned pnpm version is used rather than whatever is
  installed globally.

```bash
corepack enable
pnpm install --frozen-lockfile
```

`--frozen-lockfile` is deliberate: this example pins exact versions of the upstream x402 packages
and the protocol packages, and an install that silently resolves something else invalidates the
conformance vectors.

## Path 1: the reproducible fixture run

Nothing here touches a network. The origin listens on the loopback interface, the facilitator runs
in this process, and the wallet is a stand-in that returns fixed placeholder bytes.

```bash
pnpm test:imports     # upstream export paths and exact version pins
pnpm test:golden      # conformance vectors and staged-validation reporting
pnpm test:negative    # rejection corpus
pnpm test:keys        # key creation, persistence and fail-closed loading
pnpm test:preflight   # preflight revalidation and recipient validation
pnpm test:flow        # offline end-to-end run and the lifecycle failure branches
pnpm test:svm         # security, replay, binding and tamper cases
pnpm typecheck        # TypeScript 7, primary
pnpm typecheck:compat # TypeScript 6, compatibility gate
pnpm test:acceptance  # every declared acceptance case executed
```

`pnpm test` runs all of the above in that order, stopping at the first failure, and it is what
continuous integration runs, so the two cannot diverge. The acceptance gate is last because it
checks that every declared case executed, which only means something once everything that records
a case has run.

Then the run itself:

```bash
pnpm demo:fixture
```

This performs one full exchange: the unpaid request that produces the challenge, the payment, the
retry, settlement, and the write of the result. It then exercises each failure branch, issues the
record, writes `fixtures/expected-evidence/` and verifies what it wrote.

The directory it writes is committed. Running the demonstration again rewrites it with identical
bytes, so `git diff` after a run is the determinism check, and continuous integration runs exactly
that.

Verify the committed evidence the way an outside reader would, from the files and a public key and
nothing else:

```bash
pnpm verify
```

Then watch it refuse an edited copy:

```bash
pnpm tamper-demo
```

The demonstration copies the committed evidence to a temporary directory, changes one bound field,
and runs the same verifier. The record's signature still verifies, because the record was not
touched; what fails is the digest the record binds for the edited document. It exits non-zero if
the edit is not detected.

## Path 2: the devnet run

This spends devnet funds. It is a manual acceptance step, not part of continuous integration, and
it is the only path in this example that opens a connection.

### Configure

| Variable | Required | Meaning |
|---|---|---|
| `PEAC_EXAMPLE_PAY_TO` | yes | Recipient address for the paid resource |
| `PEAC_EXAMPLE_RPC_URL` | no | Solana devnet RPC endpoint; defaults to the upstream devnet URL |
| `PEAC_EXAMPLE_FACILITATOR_URL` | no | Facilitator endpoint; defaults to the upstream default |

### Preflight

```bash
pnpm demo:devnet:prepare
```

The preflight checks everything before anything is signed:

1. the configured network is Solana devnet, the asset is the devnet USDC mint, and the recipient is
   a real Solana address. The recipient is validated as an address here, before any connection is
   opened, so a typo stops the run instead of being discovered by the chain after a payment has
   been built and signed. Whitespace around it is refused rather than trimmed, because trimming
   would guess at the intent and could pay a different address than the one configured;
2. a devnet payer key exists at `.local/keys/payer.json`, or one is created there with owner-only
   permissions. It is created once and reused, because regenerating it would strand every previous
   airdrop. Only the public address is ever printed. A key file that exists but cannot be read as a
   key is refused and left exactly as it is, never replaced;
3. the RPC endpoint's genesis hash matches the devnet CAIP-2 identifier, so a misconfigured
   endpoint fails here rather than halfway through a payment;
4. the payer holds enough devnet USDC. Its SOL balance is reported but required of nothing: see
   below;
5. the configured facilitator advertises the exact scheme on that network.

It fails closed and prints the payer address you need to fund.

### Funding

The payer needs devnet USDC, from the Circle testnet faucet, <https://faucet.circle.com>,
selecting Solana devnet. The faucet takes the payer address printed by the preflight.

**The payer does not need devnet SOL.** In the exact scheme the transaction fee is paid by the
facilitator, not by the payer: the resource server advertises the facilitator's own address as the
fee payer, the client sets that address as the transaction's fee payer and only partially signs,
and the facilitator refuses any payment whose fee payer is not one of its own. The payer signs
solely as the authority on the token transfer, which moves USDC and spends none of its own
lamports. The preflight prints the SOL balance because it is useful to see, and gates nothing on
it.

Re-run the preflight until every check passes. It records that a wallet was prepared here, which is
a convenience for you and nothing more: the live run repeats every check itself.

### Run

```bash
pnpm demo:devnet
```

Same origin, same middleware, same client as the offline run. Three things differ: the facilitator
is the configured x402 facilitator, the client registers the upstream SVM exact scheme with the
devnet keypair, and the transaction reference is real.

The run prints the payer address, the recipient, the response status, the payment status, the
lifecycle it reached and the transaction reference.

### What the run writes

It then emits evidence, through the same capture, binding, issuance and verification code the
offline run uses. Only the inputs that genuinely differ are supplied: the devnet issuer key from
`.local/keys/issuer.json`, the real clock, the request the origin observed, the configured
facilitator as the observation source, and no supplied record identifier, because a run that
happened once has no bytes to reproduce.

The request binding of a live run describes the request that was actually served, taken from the
socket it arrived on: the scheme, the authority including the ephemeral port the origin was
listening on, and the origin-form target exactly as received. The fixture run cannot do that and
does not pretend to; it binds a fixed synthetic resource identity so its bytes reproduce, and says
so in `determinism-note.txt`. The resource URL advertised in the x402 payment requirements is a
separate, x402-owned field and stays the configured value in both modes.

Evidence is written to `out/<runId>/`, where `runId` is the instant the run was observed. That
directory is gitignored: it describes one run rather than a fixture. It does not write into
`fixtures/expected-evidence/`, which belongs to the reproducible fixture run and is checked byte for
byte, so a live run must never overwrite it.

```text
out/devnet-<timestamp>/
  record.jws                        the PEAC record issued for this run
  request-binding.json              the operation that was requested
  origin-result-binding.json        the result the origin produced, by digest
  origin-result-body.bin            the bytes that digest covers
  chain-observation.json            the settlement as this service observed it
  artifacts/payment-required.txt    the challenge value the origin emitted
  artifacts/payment-signature.txt   the payment value the client presented
  artifacts/payment-response.txt    the settlement value the origin emitted
  verification-report.txt           the verification below, as printed
```

Which of those exist depends on where the run ended: the artifact presence contract below is the
same in both modes, and a live run that failed at verification or settlement writes the smaller set
that state declares.

The run then verifies what it wrote, from those files and the public key alone, and prints the
report. It exits non-zero if that verification does not pass, so a run cannot leave behind evidence
it never checked. `pnpm verify` remains a check of the committed fixture directory; a live run
verifies its own output as it finishes.

### Endpoints a devnet run may contact

Three, and no others:

1. the Solana devnet RPC endpoint, default or `PEAC_EXAMPLE_RPC_URL`;
2. the x402 facilitator, default or `PEAC_EXAMPLE_FACILITATOR_URL`;
3. the loopback origin this process itself started.

The public faucet is contacted by you, in a browser, not by this code. Nothing else in the
example opens a connection, which is why the fixture path passes in a container with no network
interface at all.

## The lifecycle, and where a run can end

The order below is what the installed x402 express middleware does, not a design this example
chose. Verification happens first; the response is then intercepted and buffered; the resource
handler runs; a throw or an error status cancels the verified payment without settling; otherwise
settlement runs, and only then is the buffered result released to the client.

```text
REQUEST
  -> PAYMENT_REQUIRED            402 with the payment-required field
  -> PAYMENT_PAYLOAD_RECEIVED    retry carrying the payment-signature field
  -> PAYMENT_VERIFIED            verification accepted
  -> RESOURCE_EXECUTED           the handler ran; its output is buffered, not yet visible
  -> PAYMENT_SETTLED             settlement succeeded; a payment-response field is available
  -> RESPONSE_PREPARED           result and settlement field ready to write
  -> RESPONSE_WRITE_ATTEMPTED    the write was attempted; delivery is NOT claimed
```

Two consequences shape everything else. Settlement happens after the resource has already been
produced, so "the work was done and the payment did not settle" is an ordinary state rather than an
edge case. And an origin can only observe that it attempted to write; whether the client received
anything is not observable from here, which is why the successful terminal state is
`response_write_attempted` and never anything that reads as delivery.

### Failure branches

| Branch | Terminal state | What happened |
|---|---|---|
| F0 | `payment_rejected_pre_verification` | A payment was presented whose terms do not match the advertised requirements. The resource server refused it and the facilitator was never asked. |
| F1 | `verification_rejected` | The payment was refused. The handler never ran. |
| F2 | `handler_error_status` | The handler failed, by throwing or by returning an error status. Canceled without settling. |
| F3 | `settlement_failed` | The resource was produced and settlement failed. The result was never written to the client. |
| F4 | (not a lifecycle state) | A bound document was modified after the fact. This is the tamper class, caught by verification rather than by the lifecycle. |

Three measured details, stated because they change what the evidence can distinguish:

- **F0 is derived, not reported.** No hook fires when the resource server refuses a payment during
  requirements matching, and the facilitator is never asked, so the state is derived from what was
  observed: a payment field was presented, the run finished, and no verification hook ever fired.
  The name stays generic because the reason for the refusal is not exposed to anything this flow
  observes, and naming one would be a claim the origin cannot support.
- **F2 covers both handler failures, because express erases the difference.** Express catches a
  throw from a route handler and turns it into an error response before the payment middleware sees
  it, so the middleware reports a throw and a returned error status under the same cancellation
  reason, `handler_failed`, and they are told apart by the status alone. Only states this flow can
  actually reach are carried as signed terminal values: a separate state for a throw, or for a
  failed response write, would be a field nothing here can produce, and a reader could not tell one
  that never occurred from one that cannot. Another transport may distinguish them; this example
  does not pretend to.
- **F3 is the state the evidence model exists for.** The customer's request was served and the
  payment did not settle, so the middleware discarded the buffered result and wrote an error
  response instead. The evidence records the result that was produced, and records that it was
  never written.

## Artifact presence contract

An evidence directory is ambiguous in one way that matters: a reader cannot otherwise tell "this
run never produced that artifact" from "someone removed it". Each terminal state therefore declares
which artifacts must exist, which must not, and which are genuinely conditional. The terminal state
is carried inside the signed record, so it cannot be edited to excuse a missing file.

| Artifact | write attempted | refused pre-verification | verification rejected | handler error status | settlement failed | challenge only |
|---|---|---|---|---|---|---|
| `record.jws` | required | required | required | required | required | required |
| `request-binding.json` | required | required | required | required | required | required |
| `chain-observation.json` | required | required | required | required | required | required |
| `artifacts/payment-required.txt` | required | required | required | required | required | required |
| `artifacts/payment-signature.txt` | required | required | required | required | required | absent |
| `artifacts/payment-response.txt` | required | absent | absent | absent | optional | absent |
| `origin-result-binding.json` | required | absent | absent | required | required | absent |
| `origin-result-body.bin` | required | absent | absent | required | required | absent |

`absent` is as load-bearing as `required`: a settlement artifact present in a run that recorded no
settlement is inconsistent evidence, and the verifier says so.

The one `optional` entry is justified rather than convenient. When settlement fails the middleware
still emits the failure response's headers, and whether a settlement field appears among them
depends on the failure. Recording it when it appears is useful; requiring it would fail honest
runs.

## Troubleshooting

**No pnpm at all, and none wanted.** Corepack ships with Node, so the pinned version can be used
without installing or enabling anything. This is the whole path, and it needs no `corepack enable`
and no shim on `PATH`:

```bash
corepack pnpm@8.15.0 install --frozen-lockfile
corepack pnpm@8.15.0 test
```

Every step of `test` is spawned as `node <local entry point>` rather than as a nested package
manager command, so nothing in the run resolves `pnpm` from `PATH`. Run
`node scripts/run-all.mjs` directly after installing if you would rather not involve corepack in
the second command either.

**`pnpm install --frozen-lockfile` fails.** The lockfile and `package.json` disagree. Do not drop
the flag to make it pass: that resolves different upstream versions than the ones the conformance
vectors were produced against.

**`pnpm demo:fixture` leaves a `git diff` in `fixtures/expected-evidence/`.** The run is no longer
reproducing the committed evidence. Read the diff before regenerating anything: a change in the
record bytes alone points at the issuance inputs, while a change in a sidecar document points at
what the run observed.

**`pnpm demo:devnet` stops on a preflight failure.** It runs the whole preflight itself, against
current conditions, immediately before building anything, so read the failed check and resolve it
the same way you would for `pnpm demo:devnet:prepare`. Nothing was built, signed or sent.

**`pnpm demo:devnet` says there is no payer key.** Run `pnpm demo:devnet:prepare`, which creates
one and prints the address to fund. The live run never creates a key itself: a fresh one would be
unfunded, and the run would fail in the middle of a payment rather than before it.

**The preflight reports the wrong genesis hash.** `PEAC_EXAMPLE_RPC_URL` points at a cluster that
is not devnet. This example supports Solana devnet only.

**The preflight reports insufficient USDC.** Fund the printed payer address at the Circle testnet
faucet above and run it again. The payer key is reused, so previously funded balances are not lost.
A zero SOL balance is not a failure and does not need funding.

**The preflight refuses an existing key file.** A key file that cannot be read as a key is never
replaced, because replacing it would destroy a key that may hold funds. Move or repair the named
file yourself, then run the preflight again.

## What a successful verification means

Repeating the boundary from the README, because it is the sentence most easily overstated:
successful verification establishes that a record has not been altered since it was signed, and
that the signer held the private key matching the public key supplied to the verifier. It does not
establish that the key belongs to any particular organization, that the statements inside the
record are true, or that any external event described by it occurred.

Chain facts are issuer observations. The service records the transaction it was given and the
conditions under which it treated the payment as settled. Anyone can check that reference against
the network themselves, which is the point of recording it.
