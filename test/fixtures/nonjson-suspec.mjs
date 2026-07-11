#!/usr/bin/env node
// A stub that does NOT emit parseable JSON — exercises invoke_suspec's launch-error fallbacks.
// `check empty` (second positional arg "empty") → prints nothing (empty stdout); anything else → prints non-JSON garbage on stdout +
// a line on stderr (so the launch-error message can surface the stderr tail).
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (positional[1] === "empty") {
  process.exit(0);
}
process.stderr.write("boom: the suspec binary fell over");
process.stdout.write("this is not json at all");
process.exit(3);
