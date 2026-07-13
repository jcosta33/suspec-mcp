#!/usr/bin/env node

import { validContract } from "./valid-contract.mjs";

if (process.argv.includes("--contract")) {
  process.stdout.write(`${JSON.stringify(validContract)}\n`);
  process.exit(0);
}

process.stdout.write(
  `${JSON.stringify({
    level: "clean",
    path: "/first.md",
    diagnostics: [],
  })}\n${JSON.stringify({ malformed: true })}\n`,
);
