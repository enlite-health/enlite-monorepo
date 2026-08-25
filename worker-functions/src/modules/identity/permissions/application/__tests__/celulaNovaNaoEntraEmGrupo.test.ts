/**
 * C10 — célula nova NÃO entra em grupo default nem no "Acesso Master" sem a
 * revisão da C12.
 *
 * ⚠️ É outra exigência NEGATIVA, e negativa é a que se perde. O caminho de
 * quebrar isto é simpático e óbvio: "o sync criou `worker_contact:read`, o
 * Acesso Master é o grupo que tem tudo, então o sync devia dar a ele também".
 * Se alguém fizer isso, TODA célula nova nasce concedida ao grupo mais
 * poderoso — e a revisão de mínimo necessário (C12, ≤30 dias) passa a revisar
 * um fato consumado em vez de decidir.
 *
 * O seed da 206 deu ao Acesso Master `SELECT id FROM permissions` — todas as 43
 * DAQUELE momento. Isso foi uma decisão pontual, numa migration, com o conjunto
 * conhecido. Repetir a mesma linha dentro do SYNC transforma decisão pontual em
 * automatismo, e é exatamente a diferença que a C10 protege.
 */

import * as fs from 'fs';
import * as path from 'path';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

function ler(rel: string): string {
  return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
}

/** Onde a concessão a grupo poderia entrar de carona. */
const FONTES_DO_SYNC = [
  'src/modules/identity/permissions/application/SyncPermissionCatalogUseCase.ts',
  'src/modules/identity/permissions/infrastructure/catalog/permissionMetadata.ts',
  'migrations/281_iam_catalog_sync_functions.sql',
];

describe('C10 — o sync do catálogo cria a célula e não a concede a ninguém', () => {
  it('as fontes do sync existem — sem isto o teste passa no vácuo', () => {
    for (const f of FONTES_DO_SYNC) {
      expect([f, fs.existsSync(path.join(RAIZ, f))]).toEqual([f, true]);
    }
  });

  it('NENHUMA fonte do sync escreve em `group_permissions`', () => {
    for (const f of FONTES_DO_SYNC) {
      expect([f, /group_permissions/i.test(ler(f))]).toEqual([f, false]);
    }
  });

  it('nem menciona "Acesso Master" ou os ids de grupo semeados', () => {
    // O id do Acesso Master é fixo desde a 206 (a0000000-…-0001). Se ele
    // aparecer no caminho do sync, alguém está concedendo por id.
    for (const f of FONTES_DO_SYNC) {
      const src = ler(f);
      expect([f, /Acesso Master/i.test(src)]).toEqual([f, false]);
      expect([f, /a0000000-0000-0000-0000-00000000000\d/.test(src)]).toEqual([f, false]);
    }
  });

  it('o seed da 206 CONCEDE — e é ele que a C10 não deixa virar automatismo', () => {
    // Controle positivo: se este teste ficar verde por `group_permissions` não
    // existir em lugar nenhum (renomeada, por exemplo), os de cima estariam
    // verdes por vácuo. Aqui a string TEM de aparecer.
    const seed = ler('migrations/206_permissions_iam_foundation.sql');
    expect(seed).toContain('INSERT INTO group_permissions');
    expect(seed).toContain('SELECT v_g_master, id FROM permissions');
  });

  it('as células novas da F2 não foram semeadas em grupo por migration nova', () => {
    // `worker_contact:read` e `worker:disable` nasceram na C2. Nenhuma migration
    // depois da 206 pode tê-las concedido a grupo.
    const dir = path.join(RAIZ, 'migrations');
    const novas = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && /^2(0[7-9]|[1-9]\d)/.test(f));
    expect(novas.length).toBeGreaterThan(0);

    const culpadas = novas.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return /INSERT INTO group_permissions/i.test(sql)
        && /worker_contact|worker'\s*,\s*'disable/i.test(sql);
    });
    expect(culpadas).toEqual([]);
  });
});
