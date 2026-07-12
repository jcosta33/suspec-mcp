#!/usr/bin/env node

const delay = process.argv.includes("slow") ? 300 : 0;

setTimeout(() => {
  process.stdout.write(JSON.stringify({ level: "clean", diagnostics: [] }));
}, delay);
