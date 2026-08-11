# Contributing

This is a reference implementation, not a product with a support contract. Contributions are
welcome where they make the reference more accurate, or easier to reproduce independently.

## Install and test

```bash
corepack pnpm@8.15.0 install --frozen-lockfile
corepack pnpm@8.15.0 test
```

`test` runs every suite, both typechecks and the acceptance-matrix completeness gate, in order,
stopping at the first failure. The individual commands are listed in the [README](README.md#run),
and the full command path is in the [walkthrough](docs/WALKTHROUGH.md).

## Scope

In scope: x402 v2, scheme `exact`, on SVM (Solana); the deterministic offline path; and offline
verification of an evidence directory from files and a public key alone. The manual Solana Devnet
acceptance path is also in scope: it runs the same evidence pipeline against a real payment and a
real transaction signature, and it is a documented manual procedure rather than a
continuous-integration job.

Out of scope: other schemes such as `upto`, EVM and other non-SVM networks, batch settlement,
streaming responses, mainnet, and MCP carriers. This example also does not extend or modify the
PEAC wire format, record registry, extension registry or conformance requirements, and a change
that would is a change for a different repository.

## Contributions that help

- **Interoperability reports** against real x402 implementations: what was exchanged, what this
  reference accepted or refused, and at which named stage.
- **Fixture and vector corrections**, with the evidence that the current value is wrong.
- **Verification-boundary wording**, wherever the text claims more than verification establishes.
- **Reproducibility reports** from other platforms, Node versions or package managers, including
  the exact versions and the observed output.

## Reporting an issue

Open an issue with a minimal reproduction and exact versions: Node, pnpm, operating system, and the
resolved `@x402/*` and `@solana/kit` versions. Include the failing output verbatim rather than
summarised. For a suspected vulnerability follow [SECURITY.md](SECURITY.md) instead, and do not
open a public issue.

## The engineering bar

- **Claims are measured.** If the text says something is checked, a test checks it, and the text
  names what the check does not establish.
- **Changes fail closed.** An input that cannot be recognised is refused, never assumed benign.
- **Every change extends the named matrix.** Acceptance cases carry stable identifiers in
  `src/acceptance-ids.ts`; a new property gets a new identifier, and no case is reported as
  executed until its test runs.
- **Determinism holds.** The offline path writes byte-identical evidence across runs. A change that
  moves those bytes updates `fixtures/expected-evidence/` in the same commit and says why.
