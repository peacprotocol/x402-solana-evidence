# PEAC Payment Evidence Example

**Experimental deterministic binding profile, conformance fixtures and an x402 Solana exact-scheme
payment-evidence reference flow.**

Non-normative: it does not extend or modify the PEAC wire format, record registry, extension
registry or conformance requirements.

This example observes x402 payment field values, validates them in ordered stages using the upstream
x402 runtime validators, and binds them to the HTTP operation that was requested and to the bytes
the origin service produced. It then runs the whole thing: a real express origin behind the real
x402 payment middleware, a paying client, settlement, a signed PEAC record, and verification of the
result from the files and a public key alone.

The offline path is deterministic and needs no network, so the committed evidence in
`fixtures/expected-evidence/` can be verified from a checkout. A live Solana devnet run is a
documented manual step, not part of continuous integration.

Start with the [walkthrough](docs/WALKTHROUGH.md) for the full command path, the lifecycle state
machine and the devnet procedure.

## The gap this addresses

x402 v2 already provides signed offers, signed receipts, payment identifiers and builder codes, and
its offer-to-receipt matching compares resource URL, network, payer and recency. That binds payment
artifacts to one another. It does not bind them to the operation the client asked for, or to what
the service actually returned.

This example adds two application-local documents and nothing else:

| Profile | Binds |
|---|---|
| `org.peacprotocol.examples.payment-evidence/request-binding/1` | RFC 9421 request components, content type and encoding, request-body digest, selected observed-value digests |
| `org.peacprotocol.examples.payment-evidence/origin-result-binding/1` | status, content type and encoding, and the digest of the bytes the origin application produced |

Native x402 artifacts remain authoritative for their own claims. This example preserves, digests and
references them; it does not reinterpret settlement semantics or replace native signature checks.

## Staged validation

**Decoding is not validation.** The upstream `decode*Header` functions are transport decoders: they
accept any base64-encoded JSON object, including one with no x402 structure at all. Treating a
successful decode as "this is a valid x402 object" reports a transport fact as a schema fact.

Validation therefore runs as ordered stages. Each is reported independently as `accepted`,
`rejected` or `not_evaluated`, and a failure stops the sequence, so the report always names the
exact stage that refused the artifact.

```text
transport          strict standard base64, within the declared size bound
json               UTF-8 text the upstream decoder accepts as a JSON object
duplicate-members  no ambiguous object members
upstream-schema    the x402 v2 schema for this artifact type, evaluated by upstream code
scheme-payload     the scheme-specific payload member, for payment payloads
extensions         declared x402 extensions, evaluated by upstream extension APIs
```

### Validation authority per artifact

Every reported verdict names the authority that produced it. They are not interchangeable.

| Artifact | `upstream-schema` | Authority | Notes |
|---|---|---|---|
| `PAYMENT-REQUIRED` | evaluated | `@x402/core` v2 schema | |
| `PAYMENT-SIGNATURE` | evaluated | `@x402/core` v2 schema | plus a scheme-payload check, see below |
| `PAYMENT-RESPONSE` | **always `not_evaluated`** | local structural check | upstream ships no runtime validator for it |

For settle responses the upstream package exports no runtime validator at any export path. Rather
than invent one and label the result "x402 schema validation", this example reports a separate
`localStructuralStatus` under an explicitly local authority string. The import smoke test searches
every upstream export path for such a validator on every run, so if upstream adds one, the gate
fails and the local check must be replaced.

The scheme-payload stage exists because the upstream v2 schema types `scheme` as a free string and
`payload` as an open record. A payload naming an unsupported scheme, or carrying the wrong payload
member for the scheme it names, passes upstream schema validation. That check belongs to the scheme
profile, so this example performs it and reports it as its own stage rather than misattributing the
verdict to the upstream schema.

### Type-states

Capture and acceptance are separate operations, and the boundary is visible to the compiler rather
than being a flag a caller might forget to inspect:

```text
CapturedX402Artifact                       capture only; authorizes nothing
SchemaValidatedPaymentRequiredArtifact     requires upstream-schema accepted
SchemaValidatedPaymentPayloadArtifact      requires upstream-schema AND scheme-payload accepted
StructurallyCheckedSettleResponseArtifact  requires the local structural check accepted;
                                           upstream-schema stays not_evaluated
```

Promotion functions fail closed, and a captured artifact is not assignable where a validated one is
required. Preserving a malformed artifact is evidence; it is never authorization.

### Diagnostics

Failures are reported as at most eight `{stage, code, path}` entries, with path depth at most eight
and a total serialized size of at most one kibibyte. Codes come from a fixed vocabulary. No message
text produced by a validator over attacker-controlled input is retained, because that text can
embed the input itself.

## Duplicate members, I-JSON and JCS

RFC 8259 says object member names SHOULD be unique; it does not forbid duplicates, and `JSON.parse`
silently keeps the last occurrence. I-JSON (RFC 7493) does forbid them, and JCS (RFC 8785)
canonicalization is defined over I-JSON-compatible input.

This example canonicalizes decoded artifacts and binds the resulting bytes cryptographically, so an
object with ambiguous members must never reach canonicalization: two parsers could disagree about
which value the signed digest covers. A bounded scanner therefore tokenizes the decoded text,
decoding string escapes so that `"a"` and `"a"` are recognised as the same member name, and
refuses anything it cannot describe unambiguously.

**This is a PEAC binding-safety requirement, not an x402 conformance rule.** x402 does not declare
duplicate members invalid, and a `duplicate-members` rejection is never an upstream verdict.

## Representation taxonomy

Every digest names what it covers:

```text
observed       the exact field value at the APPLICATION CAPTURE BOUNDARY, preserved without
               decode-and-re-encode substitution
decoded        the base64-decoded payload bytes
validated      an object accepted by a stated validation authority, canonicalized with JCS
```

`observed` means the value as the application framework exposed it after HTTP parsing. It is **not**
raw TCP or TLS bytes, and nothing here should be read as wire-level preservation. The accepted field
value passes a visible-ASCII gate and is then digested as UTF-8 bytes.

Two result digests exist and are never conflated:

- `bodyDigest` on the origin result binding covers bytes the origin produced **before transfer
  encoding or gateway transformation**. This is what the issuer can attest.
- A client-observed digest, if any, is reported by that client and is **not** signed here. The
  origin cannot observe what survived compression, transfer encoding or a CDN.

## What verification establishes

Successful verification establishes that a signed record has not been altered since it was signed,
and that the signer possessed the private key corresponding to the public key supplied to the
verifier.

It does **not** establish:

- that the key, or its holder, is trustworthy, or that the key represents any particular
  organization;
- that the statements inside the record are factually true;
- that any external event described by the record actually occurred.

Chain facts are issuer observations: a service records a transaction and the conditions under which
it treated a payment as settled. Verification establishes the integrity of that report; it does not
independently establish blockchain consensus, and it does not make the issuer's account of events
authoritative.

## Request components

Components follow RFC 9421 derived-component semantics and are taken from the message as the origin
observed it:

```text
@method      preserved exactly; HTTP methods are case-sensitive
@scheme      lowercased
@authority   host lowercased, default port for the scheme omitted
@path        percent-encoded octets and dot segments preserved verbatim
@query       includes the leading "?"; a request with no query yields "?"
```

They are never rebuilt by re-parsing an absolute URL, for two reasons. URL parsers normalise:
collapsing dot segments, rewriting percent-encoding and reordering queries, any of which changes the
operation the evidence describes. And reconstructing scheme or authority from client-supplied
headers would let a caller influence what the record says. Adapters pass trusted components
explicitly, together with a `proxyTrustProfile`. Behind a reverse proxy, configure the framework's
proxy trust before treating a forwarded scheme or authority as trusted.

## Byte semantics

- Bodies are `Uint8Array`. A string would carry an implied encoding into the digest.
- x402 payment field values must be visible ASCII, and are digested as UTF-8 bytes.
- Header decoding is delegated to the installed x402 codec, which uses standard base64 JSON for
  `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` and `PAYMENT-RESPONSE`. This example does not define its
  own transport encoding.
- `payment-identifier` is an x402 **extension** carried inside `PaymentPayload.extensions`, not a
  fourth HTTP field. It is extracted and validated with the upstream extension APIs.
- Size bounds are application-local choices made by this example. They are not derived from, and
  imply nothing about, any HTTP parser limit.

## Support matrix

| Capability | State |
|---|---|
| x402 v2 | supported |
| scheme `exact` | supported |
| SVM (Solana) artifacts and identifiers | supported |
| field-value capture and staged validation | implemented |
| request binding and origin-result binding | implemented |
| conformance vectors and rejection corpus | implemented |
| end-to-end payment flow | implemented, offline and deterministic |
| PEAC signed record issuance | implemented |
| offline verification from files and a public key | implemented |
| tamper detection | implemented |
| settlement observation and chain-observation documents | implemented |
| live Solana devnet run | manual acceptance step; emits and verifies evidence under `out/`, see the [walkthrough](docs/WALKTHROUGH.md) |
| scheme `upto` | out of scope |
| batch settlement | out of scope |
| streaming responses | out of scope |
| mainnet | out of scope |
| MCP carriers | out of scope |
| EVM networks | out of scope |

## Quickstart

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test           # every suite, the acceptance matrix and both typechecks
pnpm demo:fixture   # the offline end-to-end run; writes and verifies the committed evidence
pnpm verify         # verify that evidence from the files and a public key alone
pnpm tamper-demo    # edit one bound field in a copy and watch verification name the failure
```

Then read the [walkthrough](docs/WALKTHROUGH.md) for the lifecycle, the artifact presence contract
and the Solana devnet procedure.

## Run

```bash
corepack enable

pnpm install --frozen-lockfile   # exact versions from the lockfile
pnpm test                        # the full gate
pnpm test:imports                # upstream export paths and exact version pins
pnpm test:golden                 # conformance vectors and staged-validation reporting
pnpm test:negative               # rejection corpus
pnpm test:flow                   # offline end-to-end run and the lifecycle failure branches
pnpm test:svm                    # security, replay, binding and tamper cases
pnpm test:acceptance             # every declared acceptance case executed
pnpm typecheck                   # TypeScript 7, primary
pnpm typecheck:compat            # TypeScript 6, compatibility gate
pnpm demo:binding                # deterministic binding walkthrough
pnpm demo:fixture                # offline end-to-end run, writes fixtures/expected-evidence
pnpm demo:offline                # binding walkthrough with egress diagnostics installed
pnpm verify                      # verify the committed evidence
pnpm tamper-demo                 # tamper demonstration, exits non-zero if an edit is not caught
pnpm demo:devnet:prepare         # devnet preflight, fails closed with funding instructions
pnpm demo:devnet                 # live devnet run, spends devnet funds, writes evidence to out/
pnpm gen:golden                  # regenerate the vectors, then review the diff
```

Conformance vectors live in `fixtures/golden-v1.json` with hard-coded expected bytes and digests,
and are cross-checked against a second, independently written RFC 8785 implementation. Both binding
documents validate against closed JSON Schema 2020-12 files in `schemas/`.

Acceptance cases carry stable identifiers declared in `src/acceptance-ids.ts`. The suites record
each one as it executes and `pnpm test:acceptance` fails if a declared case did not run, so
coverage cannot regress while the counts keep looking healthy. Four cases are scoped to continuous
integration, because a single local process cannot reproduce them: two repeated-run byte
comparisons and two runs with networking disabled. One case is scoped to live acceptance and is
reported as pending until someone performs a devnet run, never as a result.

One case is deliberately narrower than its name suggests, and the registry says so where it is
declared: whether an SVM fee payer is isolated from the transfer it pays for is decided by the
upstream facilitator against a real transaction, so what is asserted locally is the property this
integration owns, which is that the fee payer never becomes a party to the payment.

Fixtures are synthetic. Network and asset identifiers are the public Solana devnet constants
exported by the upstream package; every payer, recipient, fee payer, transaction and signature value
is fabricated placeholder text.

## Privacy

Payment signatures, payer identifiers, receipts and transaction references can be sensitive. Public
evidence is digest-only by default; raw artifacts stay private outside fixture mode. No private key
or payment authorization belongs in this repository, its logs, or a recorded demonstration.

## Licence

Apache-2.0
