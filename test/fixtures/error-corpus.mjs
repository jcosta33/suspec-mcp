#!/usr/bin/env node
// A stub that always emits a STRUCTURED CLI error (a JSON error object + exit 2) — exercises the
// structured-error rendering path in the envelope and in the resource body_of helper.
process.stdout.write(JSON.stringify({ error: 'Usage', message: 'simulated structured error' }));
process.exit(2);
