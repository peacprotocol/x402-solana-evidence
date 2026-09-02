/**
 * The Solana chain observation schema, against the vocabularies its TypeScript source declares.
 *
 * A closed JSON Schema and the TypeScript types it describes are two independent statements of the
 * same vocabulary, kept in separate files, and nothing stops them from drifting apart as either one
 * changes. This suite reads both and compares them member by member: the schema's `terminalState`,
 * `settlementOutcome`, `settlementFailureReason` and `rpcObservation.unavailableReason` enums, and
 * the `profile` constant, against the runtime constants the flow code itself is built from. A
 * mismatch here means one of the two was edited without the other, which is exactly the drift the
 * schema exists to catch in documents and would otherwise go unnoticed in itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMINAL_STATES } from './flow/lifecycle.ts';
import { FAILURE_REASONS } from './flow/failure-vocabulary.ts';
import { PROFILE_CHAIN_OBSERVATION, SETTLEMENT_OUTCOMES } from './flow/observe-settlement.ts';
import { UNAVAILABLE_REASONS } from './flow/observe-transaction.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(HERE, '..', 'schemas', 'solana-chain-observation.v1.schema.json'), 'utf8'),
) as {
  readonly properties: {
    readonly profile: { readonly const: string };
    readonly terminalState: { readonly enum: readonly string[] };
    readonly settlementOutcome: { readonly enum: readonly string[] };
    readonly settlementFailureReason: { readonly enum: readonly string[] };
  };
  readonly $defs: {
    readonly rpcObservation: {
      readonly properties: {
        readonly unavailableReason: { readonly enum: readonly string[] };
      };
    };
  };
};

// This suite has nothing to record: it compares two files that are already covered by other
// acceptance cases, and asserting the same identifier here as well would double-count it.

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

/**
 * Order-independent set equality, so a reordering of either list is not reported as drift.
 *
 * Compares the DISTINCT members rather than array length: `FAILURE_REASONS` in
 * `failure-vocabulary.ts` legitimately lists `handler_failed` twice (once as a term this flow
 * derives, once as a supported upstream code), and that repetition is not a vocabulary the schema
 * needs to represent twice.
 */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === setB.size && [...setA].every((v) => setB.has(v));
};

check(
  'the schema profile constant matches PROFILE_CHAIN_OBSERVATION',
  schema.properties.profile.const === PROFILE_CHAIN_OBSERVATION,
  `schema: ${schema.properties.profile.const}, code: ${PROFILE_CHAIN_OBSERVATION}`,
);

check(
  'the schema terminalState enum matches TERMINAL_STATES',
  sameSet(schema.properties.terminalState.enum, TERMINAL_STATES as unknown as string[]),
  `schema: ${JSON.stringify(schema.properties.terminalState.enum)}, code: ${JSON.stringify(TERMINAL_STATES)}`,
);

check(
  'the schema settlementOutcome enum matches SETTLEMENT_OUTCOMES',
  sameSet(schema.properties.settlementOutcome.enum, SETTLEMENT_OUTCOMES as unknown as string[]),
  `schema: ${JSON.stringify(schema.properties.settlementOutcome.enum)}, code: ${JSON.stringify(SETTLEMENT_OUTCOMES)}`,
);

check(
  'the schema settlementFailureReason enum matches FAILURE_REASONS',
  sameSet(schema.properties.settlementFailureReason.enum, FAILURE_REASONS as unknown as string[]),
  `schema: ${JSON.stringify(schema.properties.settlementFailureReason.enum)}, code: ${JSON.stringify(FAILURE_REASONS)}`,
);

check(
  "the schema rpcObservation.unavailableReason enum matches observe-transaction.ts's fixed reasons",
  sameSet(
    schema.$defs.rpcObservation.properties.unavailableReason.enum,
    UNAVAILABLE_REASONS as unknown as string[],
  ),
  `schema: ${JSON.stringify(schema.$defs.rpcObservation.properties.unavailableReason.enum)}, ` +
    `code: ${JSON.stringify(UNAVAILABLE_REASONS)}`,
);

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${failures} failure(s)\n`);
if (failures) process.exit(1);
