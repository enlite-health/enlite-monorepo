import { readFileSync } from 'fs';
import { join } from 'path';
import { PROTECTED_CELLS } from '../PgPermissionCatalogRepository';

/**
 * A lista de células que o sync NUNCA descontinua vive em dois lugares e duas
 * linguagens: `PROTECTED_CELLS` (aviso no app) e a migration 296 (a recusa real,
 * no banco). Este teste é o que impede as duas de divergirem em silêncio — e
 * afirma que a 3ª forma (`resource <> 'permission_management'`) cobre a família
 * inteira de que as duas listas são instâncias.
 */
describe('PROTECTED_CELLS × migration 296', () => {
  const sql = readFileSync(join(__dirname, '../../../../../../migrations/296_iam_anti_lockout_indirect_paths.sql'), 'utf8');

  it.each([...PROTECTED_CELLS])('%s está no ARRAY do WARNING da 296', (cell) => {
    expect(sql).toContain(`'${cell}'`);
  });

  it('toda célula protegida é da família que o UPDATE da 296 exclui', () => {
    expect(sql).toContain("p.resource <> 'permission_management'");
    for (const cell of PROTECTED_CELLS) expect(cell.startsWith('permission_management:')).toBe(true);
  });
});
