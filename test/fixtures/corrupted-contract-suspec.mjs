#!/usr/bin/env node

import { validContract } from "./valid-contract.mjs";

process.stdout.write(
  `${JSON.stringify({
    ...validContract,
    checks: [
      { ...validContract.checks[0], name: "renamed" },
      ...validContract.checks.slice(1),
    ],
  })}\n`,
);
