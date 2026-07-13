#!/usr/bin/env node

process.stdout.write(
  `${JSON.stringify({
    version: "0.17.0",
    checks: [{ id: "C001", name: "unique-ids", severity: "hard-error" }],
  })}\n`,
);
