/**
 * The pilot context: the skill levels a ship is flown with.
 *
 * The stats math asks a pilot for one skill's level at a time, so anything that can
 * answer that plugs in. There is no character system yet; every ship flies with
 * MAX_SKILLS_PILOT (every skill at V). A later character system either implements
 * PilotContext itself or feeds createPilotContext a `{ typeID, level }[]` list (the
 * shape of tools-core's dogma profile and of ESI character skills), and the callers of
 * computeShipStats do not change.
 */

import type { ShipSkill } from './skills';

export const MAX_SKILL_LEVEL = 5;

export type SkillLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Names a skill: its EVE type id and its English name.
 */
export type SkillReference = Pick<ShipSkill, 'typeID' | 'name'>;

/**
 * One trained skill.
 */
export interface PilotSkill {
  readonly typeID: number;
  readonly level: number;
}

export interface PilotContext {
  /**
   * A label for answers and traces, e.g. "max-skills".
   */
  readonly name: string;
  /**
   * The level the pilot has trained a skill to.
   *
   * @param skill - The skill to look up.
   * @returns An integer from 0 to 5.
   */
  skillLevel(skill: SkillReference): SkillLevel;
}

export interface PilotContextConfig {
  /**
   * Defaults to "custom".
   */
  readonly name?: string;
  /**
   * Trained skills: a `{ typeID, level }` list, or a Record keyed by English skill name
   * (case-insensitive) or by a type id string.
   */
  readonly skills?: readonly PilotSkill[] | Readonly<Record<string, number>>;
  /**
   * The level of every skill not in `skills`. Defaults to 0.
   */
  readonly defaultLevel?: number;
}

const TYPE_ID_KEY = /^\d+$/u;

/**
 * Builds a pilot context from skill levels.
 *
 * @param config - The pilot's name, skills and the level of every other skill.
 * @returns A frozen pilot context.
 * @throws {RangeError} When a level is not an integer from 0 to 5, or a skill is given twice.
 */
export function createPilotContext(config: PilotContextConfig = {}): PilotContext {
  const { name = 'custom', skills = [], defaultLevel = 0 } = config;
  const fallback = readSkillLevel(defaultLevel, 'defaultLevel');
  const byTypeID = new Map<number, SkillLevel>();
  const byName = new Map<string, SkillLevel>();

  const entries: [string, number][] = Array.isArray(skills) ? (skills as readonly PilotSkill[]).map((skill) => [String(skill.typeID), skill.level]) : Object.entries(skills);
  for (const [key, level] of entries) {
    const trimmed = key.trim();
    if (!trimmed) throw new RangeError('a pilot skill needs a name or a type id');
    const value = readSkillLevel(level, `skill "${trimmed}"`);
    const duplicate = TYPE_ID_KEY.test(trimmed) ? setOnce(byTypeID, Number(trimmed), value) : setOnce(byName, trimmed.toLowerCase(), value);
    if (duplicate) throw new RangeError(`skill "${trimmed}" is given more than once`);
  }

  return Object.freeze({
    name,
    skillLevel: (skill: SkillReference): SkillLevel => byTypeID.get(skill.typeID) ?? byName.get(skill.name.toLowerCase()) ?? fallback
  });
}

function setOnce<K>(map: Map<K, SkillLevel>, key: K, level: SkillLevel): boolean {
  const duplicate = map.has(key);
  if (!duplicate) map.set(key, level);
  return duplicate;
}

/**
 * Reads a skill level.
 *
 * @param value - A candidate level.
 * @param where - What the level belongs to, for the error message.
 * @returns The level.
 * @throws {RangeError} When the value is not an integer from 0 to 5.
 */
export function readSkillLevel(value: unknown, where: string): SkillLevel {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_SKILL_LEVEL) {
    throw new RangeError(`${where} must be a skill level, an integer from 0 to ${MAX_SKILL_LEVEL}; got ${JSON.stringify(value)}`);
  }
  return value as SkillLevel;
}

/**
 * The default pilot: every skill at V.
 */
export const MAX_SKILLS_PILOT: PilotContext = createPilotContext({ name: 'max-skills', defaultLevel: MAX_SKILL_LEVEL });
