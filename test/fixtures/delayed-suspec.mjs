#!/usr/bin/env node

const delay = process.argv.includes("slow") ? 300 : 0;
const path = process.argv[3];

setTimeout(() => {
  process.stdout.write(
    JSON.stringify({ level: "clean", path, diagnostics: [] }),
  );
}, delay);
