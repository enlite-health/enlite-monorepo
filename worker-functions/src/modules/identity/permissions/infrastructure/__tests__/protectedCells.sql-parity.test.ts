import { readFileSync } from 'fs';
import { join } from 'path';
import { PROTECTED_CELLS } from '../PgPermissionCatalogRepository';

/**
 * A lista de células que o sync NUNCA descontinua vive em dois lugares e duas
 * linguagens: `PROTECTED_CELLS` (aviso no app) e o `ARRAY[...]` do WARNING na
 * migration 410 (a recusa real, no banco). Este teste compara os CONJUNTOS —
 * `toContain` no arquivo inteiro era cego: a string também aparece fora do ARRAY
 * (sabotagem do gate, 28/08: tirar `:write` do ARRAY passava).
 */
describe('PROTECTED_CELLS × migration 410', () => {
  const sql = readFileSync(join(__dirname, '../../../../../../migrations/410_iam_anti_lockout_indirect_paths.sql'), 'utf8');

  function arrayDoWarning(): string[] {
    const m = sql.match(/FOREACH v_protegida IN ARRAY ARRAY\[([^\]]*)\]/);
    if (!m) throw new Error('ARRAY do WARNING não encontrado na 410');
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();
  }

  it('o ARRAY do WARNING da 410 é EXATAMENTE PROTECTED_CELLS', () => {
    expect(arrayDoWarning()).toEqual([...PROTECTED_CELLS].sort());
  });

  it('toda célula protegida é da família que o UPDATE da 410 exclui', () => {
    expect(sql).toContain("p.resource <> 'permission_management'");
    for (const cell of PROTECTED_CELLS) expect(cell.startsWith('permission_management:')).toBe(true);
  });
});
