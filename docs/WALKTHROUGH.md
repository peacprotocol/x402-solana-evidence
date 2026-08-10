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
pnpm test:flow        # offline end-to-end run and the lifecycle failure branches
pnpm test:svm         # security, replay, binding and tamper cases
pnpm test:acceptance  # every declared acceptance case executed
pnpm typecheck        # TypeScript 7, primary
pnpm typecheck:compat # TypeScript 6, compatibility gate
```

`pnpm test` runs all of the above in that order.

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

1. the configured network is Solana devnet, the asset is the devnet USDC mint, and a recipient is
   configured;
2. a devnet payer key exists at `.local/keys/payer.json`, or one is created there with owner-only
   permissions. It is created once and reused, because regenerating it would strand every previous
   airdrop. Only the public address is ever printed;
3. the RPC endpoint's genesis hash matches the devnet CAIP-2 identifier, so a misconfigured
   endpoint fails here rather than halfway through a payment;
4. the payer holds enough devnet SOL and devnet USDC;
5. the configured facilitator advertises the exact scheme on that network.

It fails closed and prints the payer address you need to fund.

### Funding

Both faucets are public and take the payer address printed by the preflight.

- Devnet SOL: the public Solana devnet faucet, <https://faucet.solana.com>.
- Devnet USDC: the Circle testnet faucet, <https://faucet.circle.com>, selecting Solana devnet.

Re-run the preflight until every check passes. It records a marker on success, and the live
demonstration refuses to start without one.

### Run

```bash
pnpm demo:devnet
```

Same origin, same middleware, same client as the offline run. Three things differ: the facilitator
is the configured x402 facilitator, the client registers the upstream SVM exact scheme with the
devnet keypair, and the transaction reference is real.

The run prints the payer address, the recipient, the response status, the payment status, the
lifecycle it reached and the transaction reference. It does not write into
`fixtures/expected-evidence/`: that directory belongs to the reproducible fixture run and is
checked byte for byte, so a live run must never overwrite it.

### Endpoints a devnet run may contact

Three, and no others:

1. the Solana devnet RPC endpoint, default or `PEAC_EXAMPLE_RPC_URL`;
2. the x402 facilitator, default or `PEAC_EXAMPLE_FACILITATOR_URL`;
3. the loopback origin this process itself started.

The public faucets are contacted by you, in a browser, not by this code. Nothing else in the
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
| F1 | `verification_rejected` | The payment was refused. The handler never ran. |
| F2 | `handler_threw` | The middleware reported that the handler threw. |
| F3 | `handler_error_status` | The handler returned an error status. Canceled without settling. |
| F4 | `settlement_failed` | The resource was produced and settlement failed. The result was never written to the client. |
| F5 | `response_write_failed` | Settlement succeeded and writing the response failed. |
| F6 | (not a lifecycle state) | A bound document was modified after the fact. This is the tamper class, caught by verification rather than by the lifecycle. |

Two measured details, stated because they change what the evidence can distinguish:

- **F2 is not reachable through express.** Express catches a throw from a route handler and turns
  it into an error response before the payment middleware sees it, so the middleware reports both a
  throw and an error status through the same cancellation reason and they are told apart by the
  status alone. The state is kept because the middleware defines the reason and another transport
  can produce it; this example never claims to have exercised it.
- **F4 is the state the evidence model exists for.** The customer's request was served and the
  payment did not settle, so the middleware discarded the buffered result and the client received
  an error. The evidence records the result that was produced, and records that it was never
  written.

## Artifact presence contract

An evidence directory is ambiguous in one way that matters: a reader cannot otherwise tell "this
run never produced that artifact" from "someone removed it". Each terminal state therefore declares
which artifacts must exist, which must not, and which are genuinely conditional. The terminal state
is carried inside the signed record, so it cannot be edited to excuse a missing file.

| Artifact | write attempted | verification rejected | handler threw | handler error status | settlement failed | write failed | challenge only |
|---|---|---|---|---|---|---|---|
| `record.jws` | required | required | required | required | required | required | required |
| `request-binding.json` | required | required | required | required | required | required | required |
| `chain-observation.json` | required | required | required | required | required | required | required |
| `artifacts/payment-required.txt` | required | required | required | required | required | required | required |
| `artifacts/payment-signature.txt` | required | required | required | required | required | required | absent |
| `artifacts/payment-response.txt` | required | absent | absent | absent | optional | required | absent |
| `origin-result-binding.json` | required | absent | absent | required | required | required | absent |
| `origin-result-body.bin` | required | absent | absent | required | required | required | absent |

`absent` is as load-bearing as `required`: a settlement artifact present in a run that recorded no
settlement is inconsistent evidence, and the verifier says so.

The one `optional` entry is justified rather than convenient. When settlement fails the middleware
still emits the failure response's headers, and whether a settlement field appears among them
depends on the failure. Recording it when it appears is useful; requiring it would fail honest
runs.

## Troubleshooting

**`pnpm: command not found`.** Corepack is not enabled, or its shims are not on `PATH`. Either run
`corepack enable` once, or prefix every command with the pinned version:

```bash
corepack pnpm@8.15.0 install --frozen-lockfile
corepack pnpm@8.15.0 test
```

**`pnpm install --frozen-lockfile` fails.** The lockfile and `package.json` disagree. Do not drop
the flag to make it pass: that resolves different upstream versions than the ones the conformance
vectors were produced against.

**`pnpm demo:fixture` leaves a `git diff` in `fixtures/expected-evidence/`.** The run is no longer
reproducing the committed evidence. Read the diff before regenerating anything: a change in the
record bytes alone points at the issuance inputs, while a change in a sidecar document points at
what the run observed.

**`pnpm demo:devnet` says no passed preflight was found.** Run `pnpm demo:devnet:prepare` first. It
records a marker under `.local/` only when every check passed.

**The preflight reports the wrong genesis hash.** `PEAC_EXAMPLE_RPC_URL` points at a cluster that
is not devnet. This example supports Solana devnet only.

**The preflight reports insufficient balances.** Fund the printed payer address at the two faucets
above and run it again. The payer key is reused, so previously funded balances are not lost.

## What a successful verification means

Repeating the boundary from the README, because it is the sentence most easily overstated:
successful verification establishes that a record has not been altered since it was signed, and
that the signer held the private key matching the public key supplied to the verifier. It does not
establish that the key belongs to any particular organization, that the statements inside the
record are true, or that any external event described by it occurred.

Chain facts are issuer observations. The service records the transaction it was given and the
conditions under which it treated the payment as settled. Anyone can check that reference against
the network themselves, which is the point of recording it.
