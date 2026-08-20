# Live Devnet Acceptance

- **Date:** 2026-08-20 (UTC)
- **Source commit:** `585af8a`
- **Network:** Solana Devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`)

## What happened

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

## Roles observed

| Role | Address |
|---|---|
| Payer | `7yhStoduFZe7mNK1Bcq4YT9VaCKnzUvQZadM46KV4ENJ` |
| Recipient | `BGbscF3wxReY6NF4izjezWDo472RU8tU2inVGQ7hWyA9` (associated token account `7eeTkTSUTBzFE2HJfZiPutn2pa4PZaEEFzBCcJGznKAV`) |
| Facilitator | the upstream default x402 facilitator, acting as fee payer |

## Transaction

- **Signature:** `3iBbukzMCopuFk7E4miJimAY6MCPydGkWxkE6ixMtUQSUG69SC9nL2RTXX52A6k34FKzbnryFuArWXTAdAyzaGJW`
- **Explorer:** https://explorer.solana.com/tx/3iBbukzMCopuFk7E4miJimAY6MCPydGkWxkE6ixMtUQSUG69SC9nL2RTXX52A6k34FKzbnryFuArWXTAdAyzaGJW?cluster=devnet
- **Amount:** 10000 base units (0.01 USDC, 6 decimals) of devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Terminal state:** `response_write_attempted`

## Two independently attributed observations

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

## Verification result

Offline verification against the signed record and the supplied public key ran all 25 named checks,
and all 25 passed:

- record signature, schema, key algorithm, key identifier and key issuer (5 checks)
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

## Tamper detection

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

## Reproducing verification

The evidence directory itself is not checked into git — only this document is. Raw evidence
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
