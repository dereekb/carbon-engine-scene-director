import { describe, expect, it } from 'vitest';
import { ModuleAudioPost } from './module-audio';
import { ModuleFxCommands, RunningModuleFxCommands } from './module-fx';
import type { ShipModuleEvent } from './modules';

function Event(kind: ShipModuleEvent['kind'], cycle: number, extra: Partial<ShipModuleEvent> = {}): ShipModuleEvent {
  return { kind, tick: 100 + cycle, cycle, activation: 1, ship: 'logi', module: 'low-0', cycleTime: 24, effectGuid: 'effects.ArmorHardening', ...extra };
}

describe('ModuleFxCommands', () => {
  it('starts an overlay on the first cycle, replays it on later ones and stops it, ignoring cycle ends', () => {
    const commands = ModuleFxCommands([Event('on', 1), Event('cycle', 1), Event('end', 1), Event('cycle', 2), Event('end', 2), Event('off', 2)]);
    expect(commands.map((command) => [command.op, command.key, command.effect.kind])).toEqual([
      ['start', 'logi|low-0', 'overlay'],
      ['cycle', 'logi|low-0', 'overlay'],
      ['stop', 'logi|low-0', 'overlay']
    ]);
  });

  it('runs beams and triggers on a target, and skips modules the page does not draw', () => {
    const beam = { module: 'high-0', effectGuid: 'effects.RemoteArmourRepair', cycleTime: 6 };
    const commands = ModuleFxCommands([
      Event('on', 1, { ...beam, target: 'tfi' }),
      Event('on', 1, { ...beam, module: 'high-1' }),
      Event('off', 0, { ...beam, module: 'high-1' }),
      Event('on', 1, { module: 'mid-1', effectGuid: 'effects.ModifyTargetSpeed', target: 'tfi' }),
      Event('on', 1, { module: 'low-1', effectGuid: 'effects.SiegeMode' }),
      Event('on', 1, { module: 'low-2', effectGuid: undefined })
    ]);
    expect(commands.map((command) => [command.op, command.key, command.effect.kind, command.target])).toEqual([
      ['start', 'logi|high-0', 'beam', 'tfi'],
      ['stop', 'logi|high-1', 'beam', undefined],
      ['start', 'logi|mid-1', 'trigger', 'tfi']
    ]);
  });

  it('restarts a beam on its new target at a retargeted cycle, with the start sounds', () => {
    const beam = { module: 'high-0', effectGuid: 'effects.RemoteArmourRepair', cycleTime: 6 };
    const commands = ModuleFxCommands([Event('on', 1, { ...beam, target: 'tfi' }), Event('end', 1, { ...beam, target: 'tfi' }), Event('cycle', 2, { ...beam, target: 'b1', retargeted: true }), Event('cycle', 3, { ...beam, target: 'b1' })]);
    expect(commands.map((command) => [command.op, command.key, command.target])).toEqual([
      ['start', 'logi|high-0', 'tfi'],
      ['start', 'logi|high-0', 'b1'],
      ['cycle', 'logi|high-0', 'b1']
    ]);
    expect(ModuleAudioPost(commands[1], 'M').events).toEqual(['remote_shipeffect_switch_size_M', 'remote_shipeffect_switch_duration_6000', 'remote_armorrepair']);
  });
});

describe('RunningModuleFxCommands (sd-time)', () => {
  it('starts every running overlay and targeted beam, and nothing for a targetless beam, a trigger or an undrawn module', () => {
    const commands = RunningModuleFxCommands([
      { ship: 'logi', module: 'low-0', effectGuid: 'effects.ArmorHardening', cycleTime: 24, tick: 40 },
      { ship: 'logi', module: 'high-0', effectGuid: 'effects.RemoteArmourRepair', target: 'tfi', cycleTime: 6, tick: 40 },
      { ship: 'logi', module: 'high-1', effectGuid: 'effects.RemoteArmourRepair', cycleTime: 6, tick: 40 },
      { ship: 'tackle', module: 'mid-1', effectGuid: 'effects.ModifyTargetSpeed', target: 'tfi', cycleTime: 5, tick: 40 },
      { ship: 'tackle', module: 'low-2', cycleTime: 10, tick: 40 }
    ]);
    expect(commands.map((command) => [command.op, command.key, command.effect.kind, command.target, command.tick])).toEqual([
      ['start', 'logi|low-0', 'overlay', undefined, 40],
      ['start', 'logi|high-0', 'beam', 'tfi', 40]
    ]);
  });
});

describe('ModuleAudioPost', () => {
  it("posts the hull-sized loop on the module's ship and stops it, and a remote rep's switches", () => {
    const [start, , stop] = ModuleFxCommands([Event('on', 1), Event('cycle', 2), Event('off', 2)]);
    expect(ModuleAudioPost(start, 'M')).toEqual({ ship: 'logi', events: ['ship_effect_M_armorhardener_play'], stops: [] });
    expect(ModuleAudioPost(stop, 'M')).toEqual({ ship: 'logi', events: ['ship_effect_M_armorhardener_stop'], stops: ['ship_effect_M_armorhardener_play'] });
    const [remote] = ModuleFxCommands([Event('on', 1, { module: 'high-0', effectGuid: 'effects.RemoteArmourRepair', cycleTime: 6, target: 'tfi' })]);
    expect(ModuleAudioPost(remote, 'M').events).toEqual(['remote_shipeffect_switch_size_M', 'remote_shipeffect_switch_duration_6000', 'remote_armorrepair']);
  });
});
