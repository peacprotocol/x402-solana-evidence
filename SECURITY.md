# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub security advisories once this repository is
published. Do not open public issues for vulnerabilities.

## Key and payment material

This repository must never contain private keys, payment authorizations, or funded-wallet material.

- **No private keys, seed phrases or signed payment authorizations** in the repository, in its
  history, in test fixtures, in logs, or in a recorded demonstration. Every account identifier in
  the fixtures is fabricated placeholder text and corresponds to no account on any network.
- **Keys used by future live modes stay outside version control**, under an ignored local
  directory, with restrictive file permissions. They are never regenerated per run and never
  printed; only the corresponding public address is ever displayed.
- **Devnet only.** Any live mode added later targets a development network with valueless test
  assets. Mainnet funds and real credentials are out of scope, and a change that would require them
  is a change that stops and asks first.
- A secret scan runs over the full history in continuous integration.

## Handling observed payment artifacts

Payment signatures, payer identifiers, receipts and transaction references can identify people and
counterparties.

- Public evidence is digest-only by default; raw artifacts stay private outside fixture mode.
- Validator diagnostics never retain message text produced over attacker-controlled input, and are
  bounded in count, depth and total size, so an untrusted payload cannot inflate what is logged or
  persisted.
- Observed field values are size-bounded before anything is decoded or digested.

## Publishing live evidence

Live payment artifacts are private by default. A deliberately public, test-network acceptance
artifact may be released only when it uses disposable test identities and assets, synthetic
application data, has completed settlement and is no longer operationally reusable, and passes an
explicit privacy and secret review. Such an artifact is attached to a release, never committed to
ordinary Git history. If raw artifacts are withheld, the published set is labelled a redacted
review subset and does not claim full independent recomputation of every native-artifact digest.

## Verification boundary

Successful verification establishes that a signed record has not been altered since it was signed,
and that the signer possessed the private key matching the public key supplied to the verifier. It
does not establish that the key or its holder is trustworthy, that the statements inside the record
are true, or that any external event described by the record occurred.
