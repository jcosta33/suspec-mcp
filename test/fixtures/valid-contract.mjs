import { readFileSync } from "node:fs";

export const validContract = JSON.parse(
  readFileSync(new URL("contract.json", import.meta.url), "utf8"),
);
