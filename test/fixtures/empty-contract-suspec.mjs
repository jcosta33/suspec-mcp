#!/usr/bin/env node

import { validContract } from "./valid-contract.mjs";

process.stdout.write(`${JSON.stringify({ ...validContract, checks: [] })}\n`);
