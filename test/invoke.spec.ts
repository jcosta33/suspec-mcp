import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invoke_suspec, type SuspecEnv } from '../src/suspec/invoke.ts';

// Direct unit tests for THE subprocess edge — the security/robustness boundary. These cover the
// fact branches (ok / structured-error) plus every failure path (bad verb, missing binary, non-JSON
// and empty output) so the boundary is the best-tested file, not the least.
const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, 'fixtures', 'stub-suspec.mjs');
const nonjson = join(here, 'fixtures', 'nonjson-suspec.mjs');

// The read/error paths run with cwd=here (no writes). The SAFE-WRITE stub paths (write/new) write
// their scaffold only into STUB_STORE (unset here), so no temp cwd is needed — but the flag test
// still runs against a throwaway cwd as belt-and-suspenders.
const env = (bin: string): SuspecEnv => ({ bin, cwd: here });
const tmpEnv = (bin: string): SuspecEnv => ({ bin, cwd: mkdtempSync(join(tmpdir(), 'suspec-mcp-invoke-')) });

describe('invoke_suspec — the subprocess edge', () => {
    it('refuses a non-allow-listed verb (defense-in-depth programming guard)', () => {
        expect(() => invoke_suspec(env(stub), 'rm', ['-rf', '/'])).toThrow(/non-allow-listed/);
    });

    it('refuses the RETIRED mutation verbs (promote opens a gh issue; work/done/evidence act)', () => {
        // v2: `promote` left the safe-write tier (it creates a GitHub issue + archives the finding).
        for (const verb of ['promote', 'work', 'done', 'evidence', 'fix']) {
            expect(() => invoke_suspec(env(stub), verb), verb).toThrow(/non-allow-listed/);
        }
    });

    it('refuses the MUTATING store subcommands (migrate rewrites artifacts; gc/purge delete them)', () => {
        // The `store` verb alone is no longer a read guarantee — only `store list` passes the edge.
        for (const sub of ['migrate', 'gc', 'purge', 'doctor']) {
            expect(() => invoke_suspec(env(stub), 'store', [sub]), sub).toThrow(
                /non-allow-listed store subcommand/,
            );
        }
        expect(() => invoke_suspec(env(stub), 'store')).toThrow(/non-allow-listed store subcommand/);
        expect(invoke_suspec(env(stub), 'store', ['list']).kind).toBe('ok');
    });

    it('always appends --json and never a write flag', () => {
        const r = invoke_suspec(env(stub), 'status');
        expect(r.invocation.command).toMatch(/--json$/);
        expect(r.invocation.command).not.toMatch(/--write|--force|--agent|--launch/);
    });

    it('returns kind:"ok" with the parsed data on success', () => {
        const r = invoke_suspec(env(stub), 'status');
        expect(r.kind).toBe('ok');
        if (r.kind === 'ok') {
            expect((r.data as { active: unknown[] }).active.length).toBeGreaterThan(0);
        }
    });

    it('returns kind:"structured-error" when the CLI emits an error object (exit 2)', () => {
        const r = invoke_suspec(env(stub), 'review', ['norun']);
        expect(r.kind).toBe('structured-error');
        if (r.kind === 'structured-error') {
            expect(r.error.error).toBe('store_run_not_found');
            expect(r.error.message).toMatch(/no run norun/);
        }
    });

    it('returns kind:"launch-error" when the binary cannot be launched', () => {
        const r = invoke_suspec(env('/nonexistent/suspec-does-not-exist'), 'status');
        expect(r.kind).toBe('launch-error');
        if (r.kind === 'launch-error') {
            expect(r.message).toMatch(/could not launch/);
        }
    });

    it('returns kind:"launch-error" with the stderr tail when output is non-JSON', () => {
        const r = invoke_suspec(env(nonjson), 'show', ['garbage']);
        expect(r.kind).toBe('launch-error');
        if (r.kind === 'launch-error') {
            expect(r.message).toMatch(/no parseable JSON/);
            expect(r.message).toMatch(/boom/); // the stderr tail is surfaced
        }
    });

    it('returns kind:"launch-error" when the CLI produces empty output', () => {
        const r = invoke_suspec(env(nonjson), 'show', ['empty']);
        expect(r.kind).toBe('launch-error');
        if (r.kind === 'launch-error') {
            expect(r.message).toMatch(/no parseable JSON/);
        }
    });

    it('catches a synchronous spawn throw (NUL-byte arg) and returns a clean launch-error, never escapes', () => {
        // spawnSync THROWS synchronously on a NUL byte. The input guards reject it upstream, but the
        // try/catch is defense-in-depth — a throw must still become a launch-error, not propagate.
        // (\x00 escape, not a raw byte: a raw NUL renders as whitespace and hides what this tests.)
        const r = invoke_suspec(env(stub), 'show', ['bad\x00stem']);
        expect(r.kind).toBe('launch-error');
        if (r.kind === 'launch-error') {
            expect(r.message).toMatch(/could not run/);
        }
    });

    it('passes allow-listed flags (--from/--scope) through to the safe-write verbs', () => {
        const e = tmpEnv(stub);
        try {
            const r = invoke_suspec(e, 'new', ['task'], {
                flags: { '--from': 'SPEC-x', '--scope': 'AC-001,AC-002' },
            });
            expect(r.invocation.command).toMatch(/--from SPEC-x/);
            expect(r.invocation.command).toMatch(/--scope AC-001,AC-002/);
            expect(r.invocation.command).toMatch(/--json$/);
        } finally {
            rmSync(e.cwd, { recursive: true, force: true });
        }
    });

    it('refuses a non-allow-listed FLAG (defense-in-depth: a slip that tried --write or --launch would throw)', () => {
        for (const flag of ['--write', '--launch', '--base']) {
            expect(() =>
                // a programming slip — the tools never build this, but a mutation/dispatch flag must
                // NEVER pass silently (--base left the allow-list with the v1 reconcile surface).
                invoke_suspec(env(stub), 'write', ['spec', 'x'], { flags: { [flag]: 'true' } })
            ).toThrow(/non-allow-listed flag/);
        }
    });
});
