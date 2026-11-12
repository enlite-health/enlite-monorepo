/**
 * acesso-do-cliente F3 (T305): o portão de duas rotas de `index.ts`.
 * `index.ts` não é importável em unit (fatos F4), então a ligação é lida do fonte.
 * O comportamento do guard (não-staff → 403, staff passa) é de
 * AuthMiddleware.authorization.test.ts; aqui prova-se que a rota USA o guard.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
const linha = (prefixo: string) => {
  const l = src.split('\n').filter((x) => x.startsWith(prefixo));
  expect(l).toHaveLength(1); // 0 = não medi
  return l[0];
};

describe('index.ts — guard de POST /api/jobs/refresh e classe de POST /api/admin/setup', () => {
  it('jobs/refresh exige staff (requireStaff), não só autenticação', () => {
    const l = linha("app.post('/api/jobs/refresh'");
    expect(l).toContain('authMiddleware.requireStaff()');
    expect(l).not.toContain('requireAuth');
  });

  it('admin/setup declara classe staff por marca e NÃO exige staff (bootstrap do 1º admin)', () => {
    const l = linha("app.post('/api/admin/setup'");
    expect(l).toContain('markRouteClass(');
    expect(src).toMatch(/\}\) as RequestHandler, 'staff'\)\);/);
    expect(l).not.toContain('requireStaff');
    expect(l).not.toContain('requireAuth');
  });
});
