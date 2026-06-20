import { describe, it, expect } from 'vitest';

import { build_envelope, respond, tool_error } from '../src/envelope.ts';
import type { SwarmResult } from '../src/swarm/invoke.ts';

// A CONTROLLED ReviewReport for the derive-logic test (deterministic, independent of any captured
// fixture — the captured-output drift tripwire lives in contract.spec.ts).
const reviewData = {
    level: 'warning',
    task: 'feat',
    diffChangedFiles: ['src/a.ts', 'package-lock.json'],
    coverage: [{ id: 'AC-002', kind: 'uncovered', message: 'requirement AC-002 is in scope but has no coverage row' }],
    verifyBinding: [],
    scopeDivergence: [],
    selfReport: { claimedNotInDiff: [], inDiffNotClaimed: ['package-lock.json'], outsideScope: ['package-lock.json'] },
    doNotChangeTouched: [],
    emptyEvidencePassRows: ['AC-004'],
    packetStructural: { badResultCells: [], badStatus: null, statusPassContradicted: false, missingSections: [] },
    hasReviewPacket: true,
};

const okResult = (data: unknown): SwarmResult => ({
    kind: 'ok',
    invocation: { command: 'swarm x --json', exitCode: 0 },
    data,
});

describe('build_envelope', () => {
    it('always sets noVerdictIssued:true and carries no verdict field of its own', () => {
        const env = build_envelope(okResult({ level: 'clean', verdict: 'clean' }));
        expect(env.noVerdictIssued).toBe(true);
        // swarm-mcp's OWN keys never include a verdict/approval (the CLI's data.verdict is exempt — passthrough)
        for (const key of ['verdict', 'pass', 'fail', 'merge', 'decision', 'approved']) {
            expect(Object.keys(env)).not.toContain(key);
        }
    });

    it('passes the CLI data through verbatim (including the CLI`s own verdict outcome)', () => {
        const env = build_envelope(okResult({ level: 'clean', verdict: 'clean' }));
        expect(env.data).toEqual({ level: 'clean', verdict: 'clean' });
    });

    it('derives a human-attention list from the real ReviewReport facts', () => {
        const env = build_envelope(okResult(reviewData), 'review');
        const attention = env.derived?.humanAttention ?? [];
        expect(env.derived?.derivedFrom).toBe('ReviewReport facts');
        expect(attention.some((a) => a.includes('AC-002'))).toBe(true); // uncovered coverage finding
        expect(attention.some((a) => a.includes('package-lock.json'))).toBe(true); // out-of-scope / not-claimed
        expect(attention.some((a) => a.includes('AC-004') && a.includes('Unverified'))).toBe(true); // empty-evidence Pass
    });

    it('derives an item for EVERY fact branch (verifyBinding, scopeDivergence, self-report, packet structural)', () => {
        const full = {
            level: 'warning',
            task: 'feat',
            diffChangedFiles: ['a.ts'],
            coverage: [{ id: 'AC-001', kind: 'orphan', message: 'orphan row AC-001' }],
            verifyBinding: [{ id: 'AC-001', kind: 'cmd-mismatch', message: 'verify cmd does not match' }],
            scopeDivergence: ['SPEC-x not in this task'],
            selfReport: { claimedNotInDiff: ['claimed.ts'], inDiffNotClaimed: ['extra.ts'], outsideScope: ['oos.ts'] },
            doNotChangeTouched: ['frozen/rotation.ts'],
            emptyEvidencePassRows: ['AC-002'],
            packetStructural: {
                badResultCells: ['AC-003'],
                badStatus: 'bogus',
                statusPassContradicted: true,
                missingSections: ['Human attention'],
            },
            hasReviewPacket: true,
        };
        const att = build_envelope(okResult(full), 'review').derived?.humanAttention ?? [];
        for (const expected of [
            'orphan row AC-001',
            'verify cmd does not match',
            'SPEC-x not in this task',
            'claimed.ts',
            'extra.ts',
            'oos.ts',
            'frozen/rotation.ts',
            'AC-002',
            'AC-003',
            'bogus',
            'status: pass',
            'Human attention',
        ]) {
            expect(att.some((a) => a.includes(expected)), `missing derived item for "${expected}"`).toBe(true);
        }
    });

    it('surfaces selfReport.runSummaryUnparsed as a human-attention item (#44 — CLI/TUI parity)', () => {
        // When the run summary parses to no machine-checkable paths, the CLI suppresses inDiffNotClaimed
        // and notes it once; the MCP triage list must carry the same note rather than silently dropping it.
        const unparsed = {
            level: 'clean',
            task: 'feat',
            diffChangedFiles: ['src/x.ts', 'src/y.ts'],
            coverage: [],
            verifyBinding: [],
            scopeDivergence: [],
            selfReport: { claimedNotInDiff: [], inDiffNotClaimed: [], outsideScope: [], runSummaryUnparsed: true },
            doNotChangeTouched: [],
            emptyEvidencePassRows: [],
            packetStructural: { badResultCells: [], badStatus: null, statusPassContradicted: false, missingSections: [] },
            hasReviewPacket: true,
        };
        const att = build_envelope(okResult(unparsed), 'review').derived?.humanAttention ?? [];
        expect(att.some((a) => a.includes('no machine-checkable file paths'))).toBe(true);
    });

    it('surfaces a structured CLI error (no worktree) as ok:false with a note, not a throw', () => {
        const env = build_envelope(
            { kind: 'structured-error', invocation: { command: 'swarm review x --json', exitCode: 2 }, error: { error: 'Usage', message: 'no worktree found for x' } },
            'review'
        );
        expect(env.ok).toBe(false);
        expect(env.noVerdictIssued).toBe(true);
        expect(env.note).toMatch(/no live run|worktree/i);
        expect(env.data).toEqual({ error: 'Usage', message: 'no worktree found for x' });
    });

    it('surfaces shape drift (the tripwire) when a review result does not match ReviewReportSchema', () => {
        // If the CLI's reconcile shape ever drifts, swarm-mcp must NOT silently derive a wrong attention
        // list — it passes the data through and notes that human-attention could not be derived.
        const env = build_envelope(okResult({ totally: 'not a review report' }), 'review');
        expect(env.ok).toBe(true);
        expect(env.derived).toBeUndefined();
        expect(env.note).toMatch(/did not match the expected ReviewReport shape/i);
        expect(env.data).toEqual({ totally: 'not a review report' }); // still passed through verbatim
    });

    it('does NOT mislabel a non-no-worktree review error as a no-worktree case', () => {
        const env = build_envelope(
            {
                kind: 'structured-error',
                invocation: { command: 'swarm review x --json', exitCode: 2 },
                error: { error: 'NoWorkspace', message: 'cannot run x: no tasks/x.md in this workspace' },
            },
            'review'
        );
        expect(env.ok).toBe(false);
        expect(env.note).toBe('cannot run x: no tasks/x.md in this workspace'); // the real message, not the worktree hint
    });
});

describe('respond', () => {
    it('turns a launch-error into a tool error (isError), not an envelope', () => {
        const result = respond({
            kind: 'launch-error',
            invocation: { command: 'swarm status --json', exitCode: 1 },
            message: 'could not launch `swarm`',
        });
        expect('isError' in result && result.isError).toBe(true);
        expect('structuredContent' in result).toBe(false);
    });

    it('turns an ok result into a tool_result carrying the envelope', () => {
        const result = respond(okResult({ level: 'clean' }));
        expect('structuredContent' in result).toBe(true);
        if ('structuredContent' in result) {
            expect(result.structuredContent.noVerdictIssued).toBe(true);
        }
    });
});

describe('tool_error', () => {
    it('carries isError and no structuredContent (so it cannot violate the success outputSchema)', () => {
        const e = tool_error('refusing a path outside the workspace root');
        expect(e.isError).toBe(true);
        expect('structuredContent' in e).toBe(false);
        expect(e.content[0].text).toContain('refusing a path');
    });
});
