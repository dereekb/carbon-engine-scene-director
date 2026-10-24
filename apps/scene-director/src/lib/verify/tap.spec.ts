import { describe, expect, it } from 'vitest';
import { PlainLine, TapBailOut, TapPlan, TapPoint, VERIFY_EXIT_BAILED, VERIFY_EXIT_FAILED, VERIFY_EXIT_PASSED, VerifyReport } from './tap';

/** A report writing into arrays. */
function Recorded(tap: boolean): { readonly report: VerifyReport; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { report: new VerifyReport({ tap, out: (line) => out.push(line), err: (line) => err.push(line) }), out, err };
}

describe('TapPoint', () => {
  it('writes a pass with its detail as a diagnostic', () => {
    expect(TapPoint(2, 'scene-document: load_scene builds valid ships', { kind: 'ok', detail: 'punisher ready' })).toEqual(['ok 2 - scene-document: load_scene builds valid ships', '# punisher ready']);
    expect(TapPoint(1, 'the tab connects to the hub', { kind: 'ok' })).toEqual(['ok 1 - the tab connects to the hub']);
  });

  it('writes a failure with its multi-line message on one diagnostic line', () => {
    expect(TapPoint(3, 'export: a 2 s beat writes 20 frames', { kind: 'fail', message: 'expected 20 frames,\n  got 18\r\n' })).toEqual(['not ok 3 - export: a 2 s beat writes 20 frames', '# expected 20 frames, got 18']);
  });

  it('writes a skip as a SKIP directive on the point line', () => {
    expect(TapPoint(4, 'record: the encoder warms up', { kind: 'skip', reason: 'no GPU\nadapter' })).toEqual(['ok 4 - record: the encoder warms up # SKIP no GPU adapter']);
  });

  it('escapes # and backslashes in a label and keeps it on one line', () => {
    expect(TapPoint(5, `fleets: squad #2\nholds C:${String.raw`\x`}`, { kind: 'ok' })).toEqual([String.raw`ok 5 - fleets: squad \#2 holds C:\\x`]);
  });
});

describe('TapPlan and TapBailOut', () => {
  it('writes the plan line', () => {
    expect(TapPlan(4)).toBe('1..4');
    expect(TapPlan(0)).toBe('1..0');
  });

  it('writes the bail line on one line', () => {
    expect(TapBailOut('tools-core unreachable:\nECONNREFUSED')).toBe('Bail out! tools-core unreachable: ECONNREFUSED');
  });
});

describe('PlainLine', () => {
  it("keeps the default mode's line format", () => {
    expect(PlainLine('a', { kind: 'ok', detail: 'd' })).toBe('ok    a - d');
    expect(PlainLine('a', { kind: 'ok' })).toBe('ok    a');
    expect(PlainLine('a', { kind: 'fail', message: 'm' })).toBe('FAIL  a - m');
    expect(PlainLine('a', { kind: 'skip', reason: 'r' })).toBe('skip  a - r');
  });
});

describe('VerifyReport', () => {
  it('writes a TAP stream: the version line, each point as it ends, info as diagnostics, the plan', () => {
    const { report, out, err } = Recorded(true);
    report.Start();
    report.Start();
    report.Point('the tab connects to the hub', { kind: 'ok' });
    expect(out).toEqual(['TAP version 13', 'ok 1 - the tab connects to the hub']);
    report.Info('renderer: unavailable');
    report.Point('combat: hits land', { kind: 'fail', message: 'no hit' });
    report.Point('record: warms up', { kind: 'skip', reason: 'no GPU' });
    expect(report.End()).toBe(VERIFY_EXIT_FAILED);
    expect(out).toEqual(['TAP version 13', 'ok 1 - the tab connects to the hub', '# info renderer: unavailable', 'not ok 2 - combat: hits land', '# no hit', 'ok 3 - record: warms up # SKIP no GPU', '1..3']);
    expect(err).toEqual([]);
    expect(report.count).toBe(3);
    expect(report.failed).toBe(1);
  });

  it('exits 0 when every check passed or skipped', () => {
    const { report } = Recorded(true);
    report.Point('a: x', { kind: 'ok' });
    report.Point('a: y', { kind: 'skip', reason: 'r' });
    expect(report.End()).toBe(VERIFY_EXIT_PASSED);
  });

  it('bails after the version line, with no plan line', () => {
    const { report, out } = Recorded(true);
    expect(report.BailOut('--only "nomatch" matched no check')).toBe(VERIFY_EXIT_BAILED);
    expect(out).toEqual(['TAP version 13', 'Bail out! --only "nomatch" matched no check']);
  });

  it('writes the default format line by line, a tally at the end, and a bail on stderr', () => {
    const { report, out, err } = Recorded(false);
    report.Start();
    report.Point('a: x', { kind: 'ok', detail: 'd' });
    report.Info('page errors: 0');
    report.Point('a: y', { kind: 'fail', message: 'm' });
    report.Point('a: z', { kind: 'skip', reason: 'r' });
    expect(report.End()).toBe(VERIFY_EXIT_FAILED);
    expect(out).toEqual(['ok    a: x - d', 'info  page errors: 0', 'FAIL  a: y - m', 'skip  a: z - r', '1 ok, 1 FAIL, 1 skip']);
    expect(report.BailOut('the hub did not start')).toBe(VERIFY_EXIT_BAILED);
    expect(err).toEqual(['verify-page cannot run: the hub did not start']);
  });
});
