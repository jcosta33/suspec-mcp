#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validContract } from "./valid-contract.mjs";

const marker = join(process.cwd(), ".suspec-contract-exit-after-probe");
const firstInvocation = !existsSync(marker);
if (firstInvocation) {
  writeFileSync(marker, "1");
}
process.stdout.write(`${JSON.stringify(validContract)}\n`);
process.exit(firstInvocation ? 0 : 1);
