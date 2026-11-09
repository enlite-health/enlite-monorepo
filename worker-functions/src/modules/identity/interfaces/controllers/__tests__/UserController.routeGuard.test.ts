/**
 * H1 / D650 — a guarda dos 2 DELETE de `/api/users` em `index.ts`.
 * `index.ts` não é importável em unit (sobe o app inteiro); mesmo molde de
 * `admissionFastSameWay.test.ts`: lê o texto da linha da rota.
 * Prova comportamental do 403 do `requireStaff`: AuthMiddleware.requireStaff (código real).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const INDEX = readFileSync(resolve(__dirname, '../../../../../index.ts'), 'utf8');
const rota = (verbo: string, path: string): string[] =>
  INDEX.split('\n').filter((l) => l.startsWith(`app.${verbo}('${path}'`));

describe('DELETE /api/users — guardas em index.ts', () => {
  it('CONTROLE POSITIVO: o padrão enxerga a rota irmã /me (1 linha)', () => {
    expect(rota('delete', '/api/users/me')).toHaveLength(1);
  });

  it('/:userId é staff-only (requireStaff) e NÃO usa o requireAuth solto', () => {
    const linhas = rota('delete', '/api/users/:userId');
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain('authMiddleware.requireStaff()');
    expect(linhas[0]).not.toContain('authMiddleware.requireAuth()');
    expect(linhas[0]).toContain("requirePermission('user', 'admin_delete')");
  });

  it('/me continua para qualquer autenticado (requireAuth), sem staff', () => {
    const [l] = rota('delete', '/api/users/me');
    expect(l).toContain('authMiddleware.requireAuth()');
    expect(l).not.toContain('requireStaff');
  });
});
