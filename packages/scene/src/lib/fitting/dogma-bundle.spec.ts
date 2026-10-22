import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DogmaBundle, fitTypeCategoryOf, mergeDogmaBundles, readDogmaBundle, readFitTypeAnswer } from './dogma-bundle';

const FIXTURE = JSON.parse(readFileSync(path.resolve(import.meta.dirname, 'fixtures/dogma-3632936.json'), 'utf8')) as DogmaBundle;

describe('dogma bundles', () => {
  it('reads the committed fixture whole', () => {
    const { bundle, problems } = readDogmaBundle(FIXTURE);
    expect(problems).toEqual([]);
    expect(bundle).toEqual(FIXTURE);
    expect(Object.values(FIXTURE.types).filter((type) => type.categoryID === 16)).toHaveLength(512);
    expect(FIXTURE.types['17732']).toMatchObject({ name: 'Tempest Fleet Issue', groupID: 27, categoryID: 6 });
  });

  it('drops malformed records with a problem, and refuses a value that is no bundle', () => {
    const { bundle, problems } = readDogmaBundle({ sdeBuild: '1', types: { 1: { typeID: 1 } }, effects: {}, attributes: { 2: { attributeID: 2, name: 'x' } }, missing: [5, 'a'] });
    expect(problems).toEqual(['dogma type 1 is malformed and was dropped']);
    expect(bundle).toEqual({ sdeBuild: '1', types: {}, effects: {}, attributes: { 2: { attributeID: 2, name: 'x', stackable: true, highIsGood: true, defaultValue: 0 } }, missing: [5] });
    expect(readDogmaBundle([]).bundle).toBeNull();
  });

  it('merges bundles, keeping only the ids no bundle has as missing', () => {
    const a: DogmaBundle = { sdeBuild: '1', types: {}, effects: {}, attributes: {}, missing: [2048, 7] };
    const b: DogmaBundle = { sdeBuild: '1', types: { 2048: FIXTURE.types['2048'] }, effects: {}, attributes: {} };
    expect(mergeDogmaBundles(a, b)).toEqual({ sdeBuild: '1', types: { 2048: FIXTURE.types['2048'] }, effects: {}, attributes: {}, missing: [7] });
  });

  it('reads a fit type answer and names categories', () => {
    expect(readFitTypeAnswer({ typeID: 448, name: 'Warp Scrambler II', groupID: 52, categoryID: 7, slot: 'mid' })).toEqual({ typeID: 448, name: 'Warp Scrambler II', groupID: 52, categoryID: 7, category: 'module', slot: 'mid' });
    expect(readFitTypeAnswer({ typeID: 1, name: 'x', groupID: 1, categoryID: 18, slot: 'bay' })?.slot).toBeNull();
    expect(readFitTypeAnswer({ typeID: 'x' })).toBeNull();
    expect([fitTypeCategoryOf(8), fitTypeCategoryOf(87), fitTypeCategoryOf(22)]).toEqual(['charge', 'fighter', 'other']);
  });
});
