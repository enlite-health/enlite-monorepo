/**
 * C10 — célula NÃO-own nova não entra em grupo default sem a revisão da C12.
 *
 * O invariante original (D338, 15/09/2026) abriu UMA exceção nomeada: o Acesso Master (id
 * FIXO `a0000000-0000-0000-0000-000000000001`, seed 206) passa a receber automaticamente toda
 * célula ATIVA do catálogo — a D285 ("célula nova nasce com 0 grupos") deixa de valer só para
 * ele.
 *
 * ⚠️ REVOGAÇÃO ESTREITA da D338 (decisão do Gabriel, 23/09/2026, mig 471): célula cujo
 * `resource` começa com `own_` abriu uma SEGUNDA exceção nomeada — não dá acesso a dado de
 * TERCEIRO (só ao próprio registro do usuário autenticado: marcar a própria notificação como
 * lida, marcar a própria presença), então passa a ser concedida a TODO GRUPO ATIVO, não só ao
 * Master (`iam.grant_own_cells_to_active_groups`, chamada no sync logo após o grant do
 * Master). O invariante para TODA CÉLULA NÃO-own continua INTACTO: nasce com 0 grupos (D285),
 * nunca entra sozinha — só o Master a recebe (D338). Este arquivo tem TRÊS blocos:
 *
 *   1. o caminho GERAL (`FONTES_DO_SYNC`) continua PROIBINDO concessão automática — inclusive
 *      ao Master — fora dos DOIS mecanismos nomeados (436/Master e 471/own_);
 *   2. o mecanismo nomeado do Master (`FONTE_MASTER_GRANT`) É AUDITADO: só concede ao id fixo
 *      do Master, nunca aos outros 4 ids de grupo semeados na 206, e nenhuma migration NOVA
 *      (>206, fora da 471) grava `group_permissions` para outro grupo por fora dele;
 *   3. o mecanismo nomeado da own_ (`FONTE_OWN_GRANT`) É AUDITADO: só concede célula cujo
 *      `resource` bate o PREFIXO `own_` (nunca uma lista hardcoded, nunca outro prefixo), a
 *      TODO grupo ATIVO (nunca por id literal — teria de valer para grupo criado no futuro).
 *
 * ⚠️ É exigência NEGATIVA, e negativa é a que se perde. O caminho de quebrar isto é simpático e
 * óbvio: "já que own_ pode ir a todo grupo, dá pra generalizar mais um prefixo" ou "já que o
 * Master recebe tudo, os outros grupos de sistema também podem" — se alguém generalizar a
 * concessão automática para QUALQUER outro grupo ou QUALQUER outro prefixo, os testes 2.x/3.x
 * abaixo caem. Se alguém remover o gate e conceder a partir de `SyncPermissionCatalogUseCase.ts`
 * ou `permissionMetadata.ts` (em vez de um dos dois mecanismos isolados e nomeados), os testes
 * 1.x caem.
 */

import * as fs from 'fs';
import * as path from 'path';

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

function ler(rel: string): string {
  return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
}

/**
 * Número da migration a partir do prefixo do arquivo (ex: `436_foo.sql` → 436).
 * A regex antiga `^2(0[7-9]|[1-9]\d)` só cobria 207-299 — migration 3xx/4xx (ex.: a
 * própria 436) passava despercebida pelos filtros "toda migration nova" abaixo.
 */
function numeroMigration(nomeArquivo: string): number {
  const m = nomeArquivo.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

/** Toda migration com número > 206 (206 é o seed original), qualquer faixa. */
function migrationsNovas(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && numeroMigration(f) > 206);
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

/**
 * O segundo lugar autorizado (revogação ESTREITA da D338, 23/09/2026, mig 471) a conceder
 * automaticamente a grupo — e só célula `own_*`, a TODO grupo ATIVO (nunca por id literal).
 */
const FONTE_OWN_GRANT_TS = FONTE_MASTER_GRANT_TS; // mesmo arquivo — chama os dois mecanismos
const FONTE_OWN_GRANT_SQL = 'migrations/471_grant_own_cells_to_active_groups_on_sync.sql';

/** O filtro CANÔNICO de `own_*`: prefixo, nunca lista de resources literais (mesmo das 468/469/470). */
const FILTRO_OWN_PREFIXO = "p.resource LIKE 'own\\_%' ESCAPE '\\'";

describe('C10 — o sync do catálogo cria a célula NÃO-own e NÃO a concede a grupo genérico', () => {
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
    const novas = migrationsNovas(dir).filter((f) => f !== path.basename(FONTE_MASTER_GRANT_SQL));
    expect(novas.length).toBeGreaterThan(0);

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

  it('NENHUMA outra migration nova (>206, fora da 436 e da 471/own_) concede a QUALQUER grupo que não o Master', () => {
    // Proibição dura: se alguém "generalizar" a concessão automática (dar a Recrutador,
    // Community Manager, Financeiro ou Super Admin também), este teste morre. A 471 é
    // excluída aqui porque é o SEGUNDO mecanismo nomeado (own_, revogação estreita da D338) —
    // auditado linha a linha no describe da own_ abaixo, não aqui.
    const dir = path.join(RAIZ, 'migrations');
    const novas = migrationsNovas(dir).filter(
      (f) => f !== path.basename(FONTE_MASTER_GRANT_SQL) && f !== path.basename(FONTE_OWN_GRANT_SQL),
    );
    expect(novas.length).toBeGreaterThan(0);

    const culpadas = novas.filter((f) => {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!/INSERT\s+INTO\s+(iam\.)?group_permissions/i.test(sql)) return false;
      return OUTROS_GRUPOS_IDS.some((id) => sql.includes(id));
    });
    expect(culpadas).toEqual([]);
  });

  it('TODO INSERT em group_permissions da 436 usa a constante v_master_id como group_id — nunca um SELECT/JOIN', () => {
    // Buraco fechado: uma função que concedesse a todos via algo como
    // `(SELECT DISTINCT group_id FROM iam.group_permissions)` no lugar de `v_master_id`
    // passaria pelos testes acima (não cita os OUTROS_GRUPOS_IDS por id literal, e o teste
    // de FORMA de cima só audita UM INSERT — o da função). Este varre TODO INSERT em
    // `group_permissions` do arquivo (catch-up + função) e exige que a primeira expressão
    // do SELECT — a que vira `group_id` — seja SEMPRE a constante `v_master_id`, nunca uma
    // subquery, nunca uma coluna vinda de outra tabela.
    const sql = ler(FONTE_MASTER_GRANT_SQL);
    const inserts = [...sql.matchAll(
      /INSERT\s+INTO\s+(?:iam\.|public\.)?group_permissions\s*\(\s*group_id\s*,\s*permission_id\s*\)\s*SELECT\s+([\s\S]*?),/gi,
    )];
    expect(inserts.length).toBeGreaterThan(0);
    for (const m of inserts) {
      const primeiraExpressao = m[1].trim();
      expect(primeiraExpressao).toBe('v_master_id');
    }
  });
});

describe('own_ (revogação ESTREITA da D338, decisão do Gabriel 23/09/2026, mig 471) — concede SÓ célula own_, a TODO grupo ativo', () => {
  it('a fonte da concessão automática own_ existe (TS + SQL)', () => {
    for (const f of [FONTE_OWN_GRANT_TS, FONTE_OWN_GRANT_SQL]) {
      expect([f, fs.existsSync(path.join(RAIZ, f))]).toEqual([f, true]);
    }
  });

  it('a função SQL da 471 filtra por PREFIXO own_ — nunca lista hardcoded, nunca outro prefixo', () => {
    // Sabotagem-alvo desta exigência: se alguém trocar `'own\_%'` por `'own_notifications'`
    // (lista hardcoded) ou generalizar para outro prefixo qualquer (`'shared\_%'`, sem
    // prefixo nenhum), este `toContain` do literal EXATO cai — é a forma mais direta de travar
    // "se alguém generalizar para outro prefixo, o teste cai".
    const sql = ler(FONTE_OWN_GRANT_SQL).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).toContain(FILTRO_OWN_PREFIXO);
    expect(sql).toContain('grant_own_cells_to_active_groups');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(/DELETE\s+FROM\s+(iam\.)?group_permissions/i.test(sql)).toBe(false);
  });

  it('a 471 concede a TODO grupo ATIVO por JOIN genérico — nunca por id literal (teria de valer para grupo futuro)', () => {
    const sql = ler(FONTE_OWN_GRANT_SQL).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).toMatch(/FROM\s+iam\.permission_groups\s+g/i);
    expect(sql).toMatch(/CROSS\s+JOIN\s+iam\.permissions\s+p/i);
    expect(sql).toMatch(/g\.archived_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/p\.deprecated_at\s+IS\s+NULL/i);
    expect(/a0000000-0000-0000-0000-00000000000\d/.test(sql)).toBe(false);
  });

  it('o repositório chama a função nomeada logo APÓS o grant do Master, na mesma transação — não monta INSERT à mão', () => {
    const ts = ler(FONTE_OWN_GRANT_TS);
    expect(ts).toContain('grant_own_cells_to_active_groups');
    expect(/INSERT\s+INTO\s+(iam\.)?group_permissions/i.test(ts)).toBe(false);
    // ordem: a chamada de own_ vem DEPOIS da chamada do Master no código-fonte (mesma
    // transação — a 471 exige "logo após grant_active_permissions_to_master").
    expect(ts.indexOf('grant_own_cells_to_active_groups')).toBeGreaterThan(
      ts.indexOf('grant_active_permissions_to_master'),
    );
  });

  it('KNOWN_OWN_CELLS — as 3 células own_ conhecidas hoje; uma QUARTA exige decisão do Gabriel', () => {
    // Varredura ESTÁTICA de toda declaração `perm.require('own_...', ...)` no código-fonte
    // (a mesma fonte que o sync do catálogo deriva). O critério de concessão automática virou
    // o NOME do prefixo `own_` — por isso toda célula NOVA com esse prefixo é auto-concedida a
    // todo grupo sem revisão humana. Se uma QUARTA aparecer, este teste FALHA de propósito:
    // a decisão de "isso realmente só afeta o próprio registro do usuário" é do Gabriel, não
    // pode ser inferida por um agente só porque o nome começa com `own_`.
    const SRC_DIR = path.join(RAIZ, 'src');
    const arquivosTs: string[] = [];
    const empilhar = (dir: string) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entrada.name === '__tests__' || entrada.name === 'node_modules') continue;
        const p = path.join(dir, entrada.name);
        if (entrada.isDirectory()) empilhar(p);
        else if (entrada.name.endsWith('.ts')) arquivosTs.push(p);
      }
    };
    empilhar(SRC_DIR);

    const encontradas = new Set<string>();
    const regexRequire = /perm\.require\(\s*['"]own_[a-z_]+['"]\s*,\s*['"][a-z_]+['"]\s*\)/g;
    for (const arquivo of arquivosTs) {
      const conteudo = fs.readFileSync(arquivo, 'utf8');
      for (const m of conteudo.matchAll(regexRequire)) {
        const partes = m[0].match(/['"]([a-z_]+)['"]\s*,\s*['"]([a-z_]+)['"]/);
        if (partes) encontradas.add(`${partes[1]}:${partes[2]}`);
      }
    }

    const KNOWN_OWN_CELLS = ['own_notifications:read', 'own_notifications:update', 'own_presence:update'];
    const novas = [...encontradas].filter((c) => !KNOWN_OWN_CELLS.includes(c));
    if (novas.length > 0) {
      throw new Error(
        `célula(s) own_ NOVA(s) encontrada(s) fora das 3 conhecidas: ${novas.join(', ')}. ` +
          'O critério de concessão automática a TODO grupo (mig 471) virou o NOME do prefixo ' +
          '`own_` — antes de deixar isso passar, volte ao Gabriel: essa célula nova dá acesso ' +
          'SÓ ao próprio registro do usuário autenticado, ou a dado de terceiro? Se a resposta ' +
          'não for claramente "só ao próprio registro", ela não pode nascer com esse prefixo.',
      );
    }
    expect([...encontradas].sort()).toEqual([...KNOWN_OWN_CELLS].sort());
  });
});
