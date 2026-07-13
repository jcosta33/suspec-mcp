#!/usr/bin/env node

import { validContract } from "./valid-contract.mjs";

process.stdout.write(
  `${JSON.stringify({ ...validContract, checks: validContract.checks.slice(0, -1) })}\n`,
);
