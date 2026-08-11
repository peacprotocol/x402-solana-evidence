/**
 * Acceptance completeness gate.
 *
 * Run after the suites. It fails if any locally scoped acceptance case declared in the registry
 * did not execute, so a case cannot be quietly removed, renamed or skipped while the counts keep
 * looking healthy.
 *
 * Cases declared outside this process are printed under their own scope and never counted as
 * results. A case declared out of process but recorded anyway also fails: the matrix would
 * otherwise present as pending something a suite already treats as done.
 */
import { ACCEPTANCE_CASES, checkCompleteness } from './acceptance-ids.ts';

const report = checkCompleteness();
const declared = Object.keys(ACCEPTANCE_CASES).length;

const describe = (id: string): string =>
  ACCEPTANCE_CASES[id as keyof typeof ACCEPTANCE_CASES].description;

console.log('\nAcceptance matrix\n');
console.log(`  declared                : ${declared}`);
console.log(`  executed locally        : ${report.executed.length}`);
console.log(`  deferred to CI          : ${report.declaredExternally.length}`);
console.log(`  pending live acceptance : ${report.pendingLiveAcceptance.length}`);
console.log(`  planned, not implemented: ${report.planned.length}`);

for (const id of report.declaredExternally) console.log(`  ci       ${id}  ${describe(id)}`);
for (const id of report.pendingLiveAcceptance) console.log(`  live     ${id}  ${describe(id)}`);
for (const id of report.planned) console.log(`  planned  ${id}  ${describe(id)}`);
for (const id of report.missing) console.log(`  MISS     ${id}  ${describe(id)}`);
for (const id of report.misscoped) {
  console.log(`  SCOPE    ${id} executed but is declared outside this process`);
}

const unknown = report.executed.filter((id) => !(id in ACCEPTANCE_CASES));
for (const id of unknown) console.log(`  UNKNOWN  ${id} was recorded but is not declared`);

if (!report.complete || unknown.length > 0) {
  console.log(
    `\nFAILED: ${report.missing.length} declared case(s) did not execute, ` +
      `${report.misscoped.length} recorded outside their declared scope\n`,
  );
  process.exit(1);
}
console.log('\nPASSED: every locally scoped case executed; nothing pending is reported as done\n');
