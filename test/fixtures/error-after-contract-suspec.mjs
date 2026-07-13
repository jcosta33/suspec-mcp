#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validContract } from "./valid-contract.mjs";

const marker = join(process.cwd(), ".suspec-error-after-contract");
if (!existsSync(marker)) {
  writeFileSync(marker, "1");
  process.stdout.write(`${JSON.stringify(validContract)}\n`);
  process.exit(0);
}
process.stdout.write(
  `${JSON.stringify({ error: "Usage", message: "simulated structured error" })}\n`,
);
process.exit(2);
