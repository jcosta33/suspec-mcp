#!/usr/bin/env node

process.on("SIGTERM", () => {});

setTimeout(() => {
  process.stdout.write(JSON.stringify({ level: "clean", diagnostics: [] }));
  process.exit(0);
}, 450);
