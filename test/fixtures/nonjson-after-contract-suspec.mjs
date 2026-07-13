#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { validContract } from "./valid-contract.mjs";

const marker = join(process.cwd(), ".suspec-nonjson-after-contract");
if (!existsSync(marker)) {
  writeFileSync(marker, "1");
  process.stdout.write(`${JSON.stringify(validContract)}\n`);
  process.exit(0);
}
process.stderr.write("boom");
process.stdout.write("not json");
process.exit(2);
