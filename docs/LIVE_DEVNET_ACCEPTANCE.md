# Live Devnet Acceptance

- **Date:** 2026-09-02 (UTC)
- **Source commit:** `b16eccd` on branch `fix/chain-observation-schema-conformance`, the commit that
  moved this reference to x402 2.24.0 and added the pending settlement state; the run is bound to
  that tree, and a run against the merged commit is a separate acceptance
- **Network:** Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)
- **Runtime:** Node 24.20.0, pnpm 8.15.0
- **x402 packages:** `@x402/core`, `@x402/express`, `@x402/extensions`, `@x402/svm` at 2.24.0
- **Solana packages:** `@solana/kit` 5.5.1, `@solana-program/token` 0.9.0
- **PEAC packages:** `@peac/crypto`, `@peac/kernel`, `@peac/protocol`, `@peac/schema` at 0.16.4

## What happened

A live x402 v2 SVM `exact` payment flow ran against Solana Devnet, end to end, through this
example's implementation:

1. A client requested a resource without payment and received a `PAYMENT-REQUIRED` challenge.
2. The client signed a Solana devnet USDC transfer and returned it as `PAYMENT-SIGNATURE`.
3. The facilitator verified the payment payload.
4. The origin executed the requested resource and produced a result.
5. The facilitator settled the payment on Solana Devnet and reported success on the first attempt;
   no pending report was received on this run.
6. The origin attempted to write the response, and recorded a `PAYMENT-RESPONSE`.
7. A Solana RPC endpoint was asked about the transaction reference, separately from the
   facilitator.
8. The example issued a signed PEAC record binding the request, the origin result, the payment
   field values and the chain observation together, and verified it offline.

## Roles observed

| Role | Address |
|---|---|
| Payer | `7yhStoduFZe7mNK1Bcq4YT9VaCKnzUvQZadM46KV4ENJ` |
| Recipient | `BGbscF3wxReY6NF4izjezWDo472RU8tU2inVGQ7hWyA9` (associated token account `7eeTkTSUTBzFE2HJfZiPutn2pa4PZaEEFzBCcJGznKAV`) |
| Facilitator | the upstream default x402 facilitator, acting as fee payer |
| Record issuer | `https://peacprotocol.org`, key identifier `payment-evidence-devnet-mt0yk3h8`, Ed25519 |

## Transaction

- **Signature:** `2ubP1YWskv44wtDWfoqfy3v8p6pxmgxHZv9irUPJNB7gH4n4gDbhjrA4bTQS6xzWFM4JytW4vmnXvDJPt5mFbMzZ`
- **Explorer:** https://explorer.solana.com/tx/2ubP1YWskv44wtDWfoqfy3v8p6pxmgxHZv9irUPJNB7gH4n4gDbhjrA4bTQS6xzWFM4JytW4vmnXvDJPt5mFbMzZ?cluster=devnet
- **Amount:** 10000 base units (0.01 USDC, 6 decimals) of devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Terminal state:** `response_write_attempted`
- **Settlement outcome:** `succeeded`

## Two independently attributed observations

The evidence carries two separate accounts of the same transaction, and they are never merged into
one. Each is recorded with its own source, and the verifier checks that they name the same
transaction without treating either as authoritative over the other.

**Facilitator settlement observation** (the account the facilitator gave when it settled the
payment):

- Source kind: `facilitator`
- Source reference: `the upstream default x402 facilitator`
- Settlement outcome: `succeeded`
- Recorded network: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`

**Separate RPC observation** (what a Solana RPC endpoint reported when asked about the same
transaction reference, independently of the facilitator):

- Source: `https://api.devnet.solana.com`
- Status: `observed`
- Slot: `492071131`
- Commitment: `confirmed`, as reported at the moment the run asked
- Statement: "RPC https://api.devnet.solana.com reported transaction
  2ubP1YWskv44wtDWfoqfy3v8p6pxmgxHZv9irUPJNB7gH4n4gDbhjrA4bTQS6xzWFM4JytW4vmnXvDJPt5mFbMzZ at slot
  492071131 with commitment confirmed at time 2026-09-02T16:48:59.000Z."

A later query of the same endpoint, made by hand after the run and not part of the evidence,
reported the transaction at the same slot with commitment `finalized` and no error. That later
answer is recorded here as a separate observation made at a separate time; it is not written into
the evidence and it is not a finality claim on the evidence's behalf.

Both observations in the evidence name the same transaction. Agreement between them is not treated
as proof or as confirmation of finality; it is two named observers reporting the same transaction,
and anyone can check the transaction reference against the network independently.

## Verification result

Offline verification against the signed record and the supplied public key ran all 27 named checks,
and all 27 passed:

- record signature and schema, key algorithm, key identifier and key issuer (4 checks)
- record type and extension groups (2 checks)
- digest recomputation for every bound document: request binding, origin result binding, chain
  observation, `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and the origin result
  body (7 checks)
- local-profile schema conformance for the request binding, origin result binding and chain
  observation, each against its committed schema under `schemas/` (3 checks)
- the artifact presence contract for the recorded terminal state (1 check)
- chain observation scheme, settlement facts against the outcome, and the outcome against the
  terminal state (3 checks)
- the rpc observation names the transaction the settlement recorded (1 check)
- cross-document consistency between the record and the chain observation: network, terminal
  state, asset, amount, and settlement response digest (5 checks)
- cross-document consistency between the origin result binding and the chain observation's service
  result digest (1 check)

## Tamper detection

A working copy of this evidence directory was mutated by changing one bound field,
`chain-observation.json`'s `amountBaseUnits` from `"10000"` to `"99999"`, and verification was run
again against the mutated copy under the same public key. Verification failed, naming the exact
checks that caught the change:

```
  FAIL  chain observation digest: recomputed sha256:ac38b621baa0ac831f70654a6ba61ecc6894b00f3d120dc8cc8f071ee5036776, record binds sha256:4c767d33701d1923b247bfa3cd505929854dbce89177a3337e9d87d0968ee48c
  FAIL  record and observation name the same amount: the record carries 10000, the observation carries 99999
```

The mutated copy was a temporary working copy, deleted after the run. The original evidence
directory this document describes was never altered.

## Reproducing verification

The evidence directory itself is not checked into git; only this document is. Raw evidence
artifacts follow this repository's [`SECURITY.md`](../SECURITY.md) publication policy ("Publishing
live evidence"), which keeps live payment artifacts private by default and treats a public
test-network acceptance artifact as a deliberate, reviewed exception attached to a release rather
than ordinary git history.

To verify an evidence directory you have been given directly:

```bash
corepack pnpm@8.15.0 verify -- --evidence <path-to-evidence-directory> --public-key <path-to-issuer-public-key.json>
```

## Verification boundary

From the README:

> Chain facts are issuer observations: a service records a transaction and the conditions under
> which it treated a payment as settled. Verification establishes the integrity of that report; it
> does not independently establish blockchain consensus, and it does not make the issuer's account
> of events authoritative.

## Previous acceptance: 2026-08-20

Retained as recorded at the time. It was run at x402 2.23.0 from commit `585af8a` and is the run
the `v0.1.0` release was cut against. The correction note inside it was added on 2026-09-02.

- **Date:** 2026-08-20 (UTC)
- **Source commit:** `585af8a`
- **Network:** Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

### What happened

A live x402 v2 SVM `exact` payment flow ran against Solana Devnet, end to end, through this
example's implementation:

1. A client requested a resource without payment and received a `PAYMENT-REQUIRED` challenge.
2. The client signed a Solana devnet USDC transfer and returned it as `PAYMENT-SIGNATURE`.
3. The facilitator verified the payment payload.
4. The facilitator settled the payment on Solana Devnet.
5. The origin executed the requested resource and produced a result.
6. The origin attempted to write the response, and recorded a `PAYMENT-RESPONSE`.
7. The example issued a signed PEAC record binding the request, the origin result, the payment
   headers and the chain observation together.

### Roles observed

| Role | Address |
|---|---|
| Payer | `7yhStoduFZe7mNK1Bcq4YT9VaCKnzUvQZadM46KV4ENJ` |
| Recipient | `BGbscF3wxReY6NF4izjezWDo472RU8tU2inVGQ7hWyA9` (associated token account `7eeTkTSUTBzFE2HJfZiPutn2pa4PZaEEFzBCcJGznKAV`) |
| Facilitator | the upstream default x402 facilitator, acting as fee payer |

### Transaction

- **Signature:** `3iBbukzMCopuFk7E4miJimAY6MCPydGkWxkE6ixMtUQSUG69SC9nL2RTXX52A6k34FKzbnryFuArWXTAdAyzaGJW`
- **Explorer:** https://explorer.solana.com/tx/3iBbukzMCopuFk7E4miJimAY6MCPydGkWxkE6ixMtUQSUG69SC9nL2RTXX52A6k34FKzbnryFuArWXTAdAyzaGJW?cluster=devnet
- **Amount:** 10000 base units (0.01 USDC, 6 decimals) of devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Terminal state:** `response_write_attempted`

### Two independently attributed observations

The evidence carries two separate accounts of the same transaction, and they are never merged into
one. Each is recorded with its own source, and the verifier checks that they name the same
transaction, network, asset, amount and settlement response digest without treating either as
authoritative over the other.

**Facilitator settlement observation** (the account the facilitator gave when it settled the
payment):

- Source kind: `facilitator`
- Settlement outcome: `succeeded`
- Recorded network: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`

**Separate RPC observation** (what a Solana RPC endpoint reported when asked about the same
transaction reference, independently of the facilitator):

- Source: `https://api.devnet.solana.com`
- Status: `observed`
- Slot: `485649640`
- Commitment: `confirmed`
- Statement: "RPC https://api.devnet.solana.com reported transaction
  3iBbukzMCopuFk7E4miJimAY6MCPydGkWxkE6ixMtUQSUG69SC9nL2RTXX52A6k34FKzbnryFuArWXTAdAyzaGJW at slot
  485649640 with commitment confirmed at time 2026-08-20T04:10:48.000Z."

Both observations are present and agree. Agreement between them is not treated as proof or as
confirmation of finality; it is two named observers reporting the same transaction, and anyone can
check the transaction reference against the network independently.

### Verification result

Offline verification against the signed record and the supplied public key ran all 25 named checks,
and all 25 passed:

- record signature and schema, key algorithm, key identifier and key issuer (4 checks)
- record type and extension groups (2 checks)
- digest recomputation for every bound document: request binding, origin result binding, chain
  observation, `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and the origin result
  body (7 checks)
- local-profile schema conformance for the request binding, origin result binding and chain
  observation (3 checks)
- the artifact presence contract for the recorded terminal state (1 check)
- chain observation scheme and settlement-outcome consistency (2 checks)
- cross-document consistency between the record and the chain observation: network, terminal
  state, asset, amount, and settlement response digest (5 checks)
- cross-document consistency between the origin result binding and the chain observation's service
  result digest (1 check)

Correction, 2026-09-02: at `v0.1.0` the check named `chain observation local profile` compared the
document's `profile` identifier only. Validation of the whole chain observation against a committed
schema, `schemas/solana-chain-observation.v1.schema.json`, was added after this run under the same
check name, and a further check, `settlement outcome consistent with the terminal state`, was added with
the `settlement_pending` lifecycle state. The run above was not repeated to produce this note; a run
against the current code reports 26 checks.

### Tamper detection

A working copy of this evidence directory was mutated by changing one bound field —
`chain-observation.json`'s `amountBaseUnits` from `"10000"` to `"99999"` — and verification was run
again against the mutated copy under the same public key. Verification failed, naming the exact
checks that caught the change:

```
  FAIL  chain observation digest: recomputed sha256:ce8476db328c2983c2e43806de1aec7865244a4ebcc328e5f75ad9022b58abfd, record binds sha256:c59ea1535bd784a75f9e1350edff7a6ed9409f953518d90de4d22ffca8f47e62
  FAIL  record and observation name the same amount: the record carries 10000, the observation carries 99999
```

The mutated copy verified against no other real evidence; it was a temporary working copy, deleted
after the run. The original evidence directory this document describes was never altered.

### Reproducing verification

The evidence directory itself is not checked into git — only this document is. Raw evidence
artifacts follow this repository's [`SECURITY.md`](../SECURITY.md) publication policy ("Publishing
live evidence"), which keeps live payment artifacts private by default and treats a public
test-network acceptance artifact as a deliberate, reviewed exception attached to a release rather
than ordinary git history.

To verify an evidence directory you have been given directly:

```bash
corepack pnpm@8.15.0 verify -- --evidence <path-to-evidence-directory> --public-key <path-to-issuer-public-key.json>
```

### Verification boundary

From the README:

> Chain facts are issuer observations: a service records a transaction and the conditions under
> which it treated a payment as settled. Verification establishes the integrity of that report; it
> does not independently establish blockchain consensus, and it does not make the issuer's account
> of events authoritative.
