import * as fs from 'fs';
import * as path from 'path';
import {
  ICD_CATEGORY_CODE_BODY,
  ICD_CATEGORY_CODE_PATTERN,
  ICD_CATEGORY_PREFIX,
  IcdCategoryCode,
  InvalidIcdCategoryCodeError,
  icdCategoryOf,
} from '../icdCategory';

const ROOT = path.resolve(__dirname, '../../../../..');

describe('icdCategoryOf (DF-5)', () => {
  it.each([
    ['6A02', '6A02'],
    ['6A02.0', '6A02'],
    ['KA00.0/XS2R&XS5W', 'KA00'],
  ])('%s -> %s', (raw, expected) => {
    expect(icdCategoryOf(raw)).toBe(expected);
  });

  it.each([['06'], [''], ['6a02'], [null], [undefined], ['.6A02'], [' 6A02']])('%p -> null', (raw) => {
    expect(icdCategoryOf(raw as string | null | undefined)).toBeNull();
  });
});

describe('IcdCategoryCode', () => {
  it('fromConceptCode devolve o VO com igualdade por valor', () => {
    const a = IcdCategoryCode.fromConceptCode('6A02.0');
    expect(a?.toString()).toBe('6A02');
    expect(a?.equals(IcdCategoryCode.parse('6A02'))).toBe(true);
    expect(a?.equals(IcdCategoryCode.parse('6A05'))).toBe(false);
  });

  it('parse aceita só o código completo de categoria e lança erro nomeado', () => {
    expect(IcdCategoryCode.parse('6A02').value).toBe('6A02');
    for (const bad of ['6A02.0', '6A0', '6a02', '', '6A022']) {
      expect(() => IcdCategoryCode.parse(bad)).toThrow(InvalidIcdCategoryCodeError);
    }
    expect(new InvalidIcdCategoryCodeError().code).toBe('icd_category_invalid');
  });
});

describe('DD-18: a forma do código tem UMA constante', () => {
  it('as âncoras derivam do corpo', () => {
    expect(ICD_CATEGORY_PREFIX.source).toBe('^' + ICD_CATEGORY_CODE_BODY);
    expect(ICD_CATEGORY_CODE_PATTERN.source).toBe('^' + ICD_CATEGORY_CODE_BODY + '$');
  });

  it('a CHECK da migration 586 usa o mesmo texto da constante', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'migrations/586_catalogo_terapeutico_por_cid.sql'), 'utf8');
    const checks = [...sql.matchAll(/category_code ~ '([^']+)'/g)].map((m) => m[1]);
    expect(checks.length).toBeGreaterThanOrEqual(2);
    for (const text of checks) expect(text).toBe(ICD_CATEGORY_CODE_PATTERN.source);
  });

  it('o regex do gerador usa o mesmo texto da constante', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/therapeutic-catalog/generateCidCatalog.ts'), 'utf8');
    const m = /const CATEGORIA = \/(.+)\/;/.exec(src);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(ICD_CATEGORY_CODE_PATTERN.source);
  });
});
