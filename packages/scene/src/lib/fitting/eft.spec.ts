import { describe, expect, it } from 'vitest';
import { MAX_FIT_LENGTH, parseEftFit, readEftPropMod } from './eft';
import { tfisComposition, TFIS_FIT_KEYS } from '../compositions/compositions.spec-helper';

function slotCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const module of parseEftFit(text).modules) counts[module.slot] = (counts[module.slot] ?? 0) + 1;
  return counts;
}

describe('parseEftFit', () => {
  it('reads every TFIs fit by section with no problems or warnings', () => {
    const fits = tfisComposition().fits ?? {};
    const expected: Record<string, readonly [Record<string, number>, number, number]> = {
      tfi: [{ low: 7, mid: 5, high: 8, rig: 3 }, 3, 27],
      zarmazd: [{ low: 6, mid: 4, high: 4, rig: 2 }, 3, 17],
      guardian: [{ low: 5, mid: 2, high: 6, rig: 2 }, 1, 7],
      revelation: [{ low: 8, mid: 4, high: 5, rig: 3 }, 13, 0],
      damnation: [{ low: 6, mid: 4, high: 7, rig: 2 }, 3, 19],
      eos: [{ low: 7, mid: 4, high: 5, rig: 2 }, 3, 18],
      bhaalgorn: [{ low: 7, mid: 5, high: 7, rig: 3 }, 3, 10],
      vindicator: [{ low: 7, mid: 5, high: 8, rig: 3 }, 1, 8],
      devoter: [{ low: 7, mid: 3, high: 5, rig: 2 }, 2, 10],
      'apostle-active': [{ low: 7, mid: 4, high: 6, rig: 3 }, 4, 9],
      thanatos: [{ low: 6, mid: 5, high: 5, rig: 3 }, 8, 11],
      nidhoggur: [{ low: 5, mid: 6, high: 5, rig: 3 }, 8, 11],
      archon: [{ low: 7, mid: 4, high: 5, rig: 3 }, 8, 7]
    };
    expect(Object.keys(expected)).toEqual(TFIS_FIT_KEYS);
    for (const key of TFIS_FIT_KEYS) {
      const fit = parseEftFit(fits[key]);
      const [slots, drones, cargo] = expected[key];
      expect({ key, slots: slotCounts(fits[key]), drones: fit.drones.length, cargo: fit.cargo.length, problems: fit.problems, warnings: fit.warnings }).toEqual({ key, slots, drones, cargo, problems: [], warnings: [] });
    }
  });

  it('reads the TFI fit header, module order, drones and cargo', () => {
    const fit = parseEftFit(tfisComposition().fits?.['tfi'] ?? '');
    expect({ hull: fit.hull, name: fit.name }).toEqual({ hull: 'Tempest Fleet Issue', name: '[FL33T] Tempest Fleet Issue' });
    expect(fit.modules[0]).toEqual({ name: 'Damage Control II', section: 0, slot: 'low', line: 3 });
    expect(fit.modules.filter((module) => module.slot === 'mid').map((module) => module.name)).toEqual(['500MN Cold-Gas Enduring Microwarpdrive', 'Heavy F-RX Compact Capacitor Booster', 'DDO Scoped Tracking Disruptor I', 'DDO Scoped Tracking Disruptor I', 'Warp Disruptor II']);
    expect(fit.drones).toEqual([
      { name: 'Warrior II', quantity: 5, line: 31 },
      { name: 'Republic Fleet Bouncer', quantity: 2, line: 32 },
      { name: 'Hornet EC-300', quantity: 5, line: 33 }
    ]);
    expect(fit.cargo[0]).toEqual({ name: 'Barrage L', quantity: 1800, line: 36 });
    expect(fit.cargo.map((item) => item.name)).toContain('Thermal Armor Hardener II');
  });

  it("keeps the Devoter's empty high slot and the Damnation's lowercase /offline bursts", () => {
    const fits = tfisComposition().fits ?? {};
    const devoter = parseEftFit(fits['devoter']);
    expect(devoter.empty).toEqual({ low: 0, mid: 0, high: 1, rig: 0, subsystem: 0, service: 0 });
    expect(devoter.modules.filter((module) => module.slot === 'high').map((module) => module.name)).toEqual(['Cynosural Field Generator I', '125mm Gatling AutoCannon I', 'M-36 Enduring Warp Disruption Field Generator', 'M-36 Enduring Warp Disruption Field Generator', 'M-36 Enduring Warp Disruption Field Generator']);
    const offline = parseEftFit(fits['damnation']).modules.filter((module) => module.offline);
    expect(offline.map((module) => module.name)).toEqual(['Armor Command Burst II', 'Armor Command Burst II', 'Armor Command Burst II', 'Skirmish Command Burst II']);
  });

  it('splits a loaded charge off and strips /OFFLINE first', () => {
    const fit = parseEftFit('[Rifter, x]\n\n200mm AutoCannon II, Republic Fleet EMP S /OFFLINE\n1MN Afterburner II');
    expect(fit.modules).toEqual([
      { name: '200mm AutoCannon II', charge: 'Republic Fleet EMP S', offline: true, section: 0, slot: 'low', line: 3 },
      { name: '1MN Afterburner II', section: 0, slot: 'low', line: 4 }
    ]);
  });

  it('reads CRLF text, every empty slot kind, an implant section and a header-only fit', () => {
    const text = [
      '',
      '[Loki, Sub test]',
      '[Empty Low slot]',
      '',
      '[Empty Med slot]',
      '',
      '[Empty High slot]',
      '',
      '[Empty Rig slot]',
      '',
      'Loki Core - Immobility Drivers',
      '[Empty Subsystem slot]',
      '',
      '[Empty Service slot]',
      '',
      '',
      'Hornet EC-300 x2',
      '',
      '',
      'Nanite Repair Paste x10',
      '',
      'Strong Blue Pill Booster',
      ''
    ].join('\r\n');
    const fit = parseEftFit(text);
    expect(fit.empty).toEqual({ low: 1, mid: 1, high: 1, rig: 1, subsystem: 1, service: 1 });
    expect(fit.modules).toEqual([{ name: 'Loki Core - Immobility Drivers', section: 4, slot: 'subsystem', line: 11 }]);
    expect(fit.drones).toEqual([{ name: 'Hornet EC-300', quantity: 2, line: 17 }]);
    expect(fit.cargo).toEqual([{ name: 'Nanite Repair Paste', quantity: 10, line: 20 }]);
    expect(fit.implants).toEqual([{ name: 'Strong Blue Pill Booster', line: 22 }]);
    expect(parseEftFit('[Rifter, Empty]')).toMatchObject({ hull: 'Rifter', name: 'Empty', modules: [], drones: [], cargo: [], problems: [], warnings: [] });
  });

  it('counts an xN line among the modules as cargo, with a warning', () => {
    const fit = parseEftFit('[Rifter, x]\nDamage Control II\nWarp Scrambler II x1\n\n1MN Afterburner II\n\n\nWarrior II x2');
    expect(fit.modules.map((module) => [module.name, module.slot])).toEqual([
      ['Damage Control II', 'low'],
      ['1MN Afterburner II', 'mid']
    ]);
    expect(fit.cargo).toEqual([{ name: 'Warp Scrambler II', quantity: 1, line: 3 }]);
    expect(fit.drones).toEqual([{ name: 'Warrior II', quantity: 2, line: 8 }]);
    expect(fit.warnings).toEqual(['line 3: "Warp Scrambler II x1" has a quantity among the modules; counted as cargo']);
  });

  it('ends the modules at the first xN line when the text has no double blank line', () => {
    const fit = parseEftFit('[Rifter, x]\nDamage Control II\n\n1MN Afterburner II\n\nWarrior II x2\n\nNanite Repair Paste x5');
    expect(fit.modules.map((module) => module.name)).toEqual(['Damage Control II', '1MN Afterburner II']);
    expect(fit.drones.map((item) => item.name)).toEqual(['Warrior II']);
    expect(fit.cargo.map((item) => item.name)).toEqual(['Nanite Repair Paste']);
  });

  it('reports a missing header, too-long text and a too-long line', () => {
    expect(parseEftFit('Damage Control II').problems).toEqual(['the fit must start with a [Hull, Fit name] header']);
    expect(parseEftFit(`[Rifter, x]\n${'a'.repeat(MAX_FIT_LENGTH)}`).problems).toEqual([`the fit is longer than ${MAX_FIT_LENGTH} characters`, 'line 2 is longer than 300 characters']);
  });

  it('warns about more slots of a kind than EVE hulls have', () => {
    const fit = parseEftFit(`[Rifter, x]\n${Array.from({ length: 9 }, () => 'Damage Control II').join('\n')}`);
    expect(fit.warnings).toEqual(['the fit has 9 low slots; EVE hulls have at most 8']);
  });
});

describe('readEftPropMod on the parser', () => {
  it('takes the first prop mod in written order, offline ones included, and never cargo', () => {
    expect(readEftPropMod('[Rifter, x]\nDamage Control II\n\n5MN Microwarpdrive II /offline\n1MN Afterburner II\n\n\n1MN Afterburner II x1')).toBe('5MN Microwarpdrive II');
    expect(readEftPropMod('[Rifter, x]\nDamage Control II\n\n\n1MN Afterburner II x1')).toBeNull();
  });
});
