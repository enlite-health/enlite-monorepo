/**
 * C10 — célula nova NÃO entra em grupo default sem a revisão da C12.
 *
 * D338 (15/09/2026, decisão do Gabriel) abriu UMA exceção nomeada: o Acesso Master (id FIXO
 * `a0000000-0000-0000-0000-000000000001`, seed 206) passa a receber automaticamente toda
 * célula ATIVA do catálogo — a D285 ("célula nova nasce com 0 grupos") deixa de valer só para
 * ele. Este arquivo virou dois testes com propósitos opostos:
 *
 *   1. o caminho GERAL (`FONTES_DO_SYNC`) continua PROIBINDO concessão automática — inclusive
 *      ao Master — fora do mecanismo nomeado da 436/`grant_active_permissions_to_master`;
 *   2. o mecanismo nomeado (`FONTE_MASTER_GRANT`) É AUDITADO: só concede ao id fixo do Master,
 *      nunca aos outros 4 ids de grupo semeados na 206, e nenhuma migration NOVA (>206) grava
 *      `group_permissions` para outro grupo por fora dele.
 *
 * ⚠️ É outra exigência NEGATIVA, e negativa é a que se perde. O caminho de quebrar isto é
 * simpático e óbvio: "já que o Master recebe tudo, os outros grupos de sistema também podem" —
 * se alguém generalizar a concessão automática para QUALQUER outro grupo, os testes 2.x abaixo
 * caem. Se alguém remover o gate e conceder a partir de `SyncPermissionCatalogUseCase.ts` ou
 * `permissionMetadata.ts` (em vez do mecanismo isolado e nomeado), os testes 1.x caem.
 */

import * as fs from 'fs';
import * as path from 'path';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

function ler(rel: string): string {
  return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
}

/** Onde a concessão automática a grupo GENÉRICO poderia entrar de carona. */
const FONTES_DO_SYNC = [
  'src/modules/identity/permissions/application/SyncPermissionCatalogUseCase.ts',
  'src/modules/identity/permissions/infrastructure/catalog/permissionMetadata.ts',
  'migrations/281_iam_catalog_sync_functions.sql',
];

/** O único lugar autorizado (D338) a conceder automaticamente — e só ao Master. */
const FONTE_MASTER_GRANT_TS = 'src/modules/identity/permissions/infrastructure/PgPermissionCatalogRepository.ts';
const FONTE_MASTER_GRANT_SQL = 'migrations/436_iam_master_grants_all_active_cells.sql';

const GROUP_MASTER_ID = 'a0000000-0000-0000-0000-000000000001';
const OUTROS_GRUPOS_IDS = [
  'a0000000-0000-0000-0000-000000000002', // Recrutador
  'a0000000-0000-0000-0000-000000000003', // Community Manager
  'a0000000-0000-0000-0000-000000000004', // Financeiro
  'a0000000-0000-0000-0000-000000000005', // Super Admin
];

describe('C10 — o sync do catálogo cria a célula e NÃO a concede a grupo genérico', () => {
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

  it('nem menciona nenhum id de grupo semeado (Master incluso — a concessão automática mora só na 436/repositório, não aqui)', () => {
    for (const f of FONTES_DO_SYNC) {
      const src = ler(f);
      expect([f, /Acesso Master/i.test(src)]).toEqual([f, false]);
      expect([f, /a0000000-0000-0000-0000-00000000000\d/.test(src)]).toEqual([f, false]);
    }
  });

  it('o seed da 206 CONCEDE — e é ele que a C10 não deixa virar automatismo genérico', () => {
    // Controle positivo: se este teste ficar verde por `group_permissions` não
    // existir em lugar nenhum (renomeada, por exemplo), os de cima estariam
    // verdes por vácuo. Aqui a string TEM de aparecer.
    const seed = ler('migrations/206_permissions_iam_foundation.sql');
    expect(seed).toContain('INSERT INTO group_permissions');
    expect(seed).toContain('SELECT v_g_master, id FROM permissions');
  });

  it('as células novas da F2 não foram semeadas em grupo por migration nova (fora do mecanismo nomeado do Master)', () => {
    // `worker_contact:read` e `worker:disable` nasceram na C2. Nenhuma migration depois da
    // 206 pode tê-las concedido a grupo — EXCETO a 436, que é o mecanismo nomeado do Master
    // e é auditada linha a linha no describe abaixo, não aqui.
    const dir = path.join(RAIZ, 'migrations');
    const novas = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && /^2(0[7-9]|[1-9]\d)/.test(f) && f !== path.basename(FONTE_MASTER_GRANT_SQL));

    const culpadas = novas.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      return /INSERT INTO group_permissions/i.test(sql)
        && /worker_contact|worker'\s*,\s*'disable/i.test(sql);
    });
    expect(culpadas).toEqual([]);
  });
});

describe('D338 — o mecanismo nomeado concede SÓ ao Acesso Master, nunca a outro grupo', () => {
  it('a fonte da concessão automática ao Master existe (TS + SQL)', () => {
    for (const f of [FONTE_MASTER_GRANT_TS, FONTE_MASTER_GRANT_SQL]) {
      expect([f, fs.existsSync(path.join(RAIZ, f))]).toEqual([f, true]);
    }
  });

  it('a função SQL da 436 concede pelo id FIXO do Master, nunca por parâmetro', () => {
    const sql = ler(FONTE_MASTER_GRANT_SQL);
    expect(sql).toContain(GROUP_MASTER_ID);
    expect(sql).toContain('grant_active_permissions_to_master');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    // nunca um DELETE EXECUTÁVEL nesta migration (o ROLLBACK comentado no cabeçalho cita
    // DELETE de propósito — por isso a checagem tira as linhas de comentário `--` primeiro)
    const semComentarios = sql
      .split('\n')
      .filter((linha) => !linha.trim().startsWith('--'))
      .join('\n');
    expect(/DELETE\s+FROM\s+(iam\.)?group_permissions/i.test(semComentarios)).toBe(false);
  });

  it('a 436 NUNCA menciona os ids dos outros 4 grupos semeados', () => {
    const sql = ler(FONTE_MASTER_GRANT_SQL);
    for (const outroId of OUTROS_GRUPOS_IDS) {
      expect([outroId, sql.includes(outroId)]).toEqual([outroId, false]);
    }
  });

  it('a forma do INSERT da função prova que o alvo é SÓ o Master — sem join com permission_groups', () => {
    // Sabotagem clássica: trocar `SELECT v_master_id, p.id FROM iam.permissions p` por um
    // `SELECT g.id, p.id FROM iam.permission_groups g CROSS JOIN iam.permissions p` concederia
    // a TODOS os grupos sem citar nenhum id literal — o teste acima não pegaria isso. Este
    // exige a FORMA exata: a única fonte de linha é `iam.permissions`, o group_id é sempre a
    // constante `v_master_id`.
    const sql = ler(FONTE_MASTER_GRANT_SQL);
    expect(sql).toMatch(/INSERT\s+INTO\s+iam\.group_permissions\s*\(group_id,\s*permission_id\)\s*SELECT\s+v_master_id,\s*p\.id\s*FROM\s+iam\.permissions\s+p\s*WHERE\s+p\.deprecated_at\s+IS\s+NULL/i);
    expect(/JOIN\s+iam\.permission_groups/i.test(sql)).toBe(false);
    expect(/FROM\s+iam\.permission_groups/i.test(sql)).toBe(false);
  });

  it('o repositório chama a função nomeada — não monta INSERT em group_permissions à mão', () => {
    const ts = ler(FONTE_MASTER_GRANT_TS);
    expect(ts).toContain('grant_active_permissions_to_master');
    // continua verdadeiro que o repositório não escreve `group_permissions` DIRETO —
    // toda escrita sai por função `iam.*` (mesma garantia de forma das demais).
    expect(/INSERT\s+INTO\s+(iam\.)?group_permissions/i.test(ts)).toBe(false);
  });

  it('NENHUMA outra migration nova (>206) concede a QUALQUER grupo que não o Master', () => {
    // Proibição dura: se alguém "generalizar" a concessão automática (dar a Recrutador,
    // Community Manager, Financeiro ou Super Admin também), este teste morre.
    const dir = path.join(RAIZ, 'migrations');
    const novas = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && /^2(0[7-9]|[1-9]\d)/.test(f) && f !== path.basename(FONTE_MASTER_GRANT_SQL));

    const culpadas = novas.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/INSERT\s+INTO\s+(iam\.)?group_permissions/i.test(sql)) return false;
      return OUTROS_GRUPOS_IDS.some((id) => sql.includes(id));
    });
    expect(culpadas).toEqual([]);
  });
});
