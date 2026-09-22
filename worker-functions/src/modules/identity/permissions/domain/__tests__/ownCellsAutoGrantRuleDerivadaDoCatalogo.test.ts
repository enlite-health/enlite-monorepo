/**
 * R4 (change 022-ux-mencao-e-notificacao, Rodada 4, pedido do Gabriel 22/09) — a regra de
 * concessão automática de células `own_*` tem de ser DERIVADA DO CATÁLOGO por PREFIXO
 * (`resource LIKE 'own\_%'`), nunca uma lista hardcoded de resources (`own_notifications`,
 * `own_presence`, ...). Achado em prd, 22/09: 464/466/467 nomeiam um resource por vez — toda
 * célula `own_*` nova exigiria outra migration de catch-up. R4 fecha os dois lados:
 *
 *   - 468 (catch-up): grupo ATIVO que já existia recebe toda `own_*` do catálogo.
 *   - 469 (estrutural): `iam.create_group` concede `own_*` já NA CRIAÇÃO.
 *
 * Este teste prova a FORMA, não o efeito em banco (isso é o e2e/integration desta rodada):
 * se alguém trocar o filtro por uma lista hardcoded (`resource IN ('own_notifications',
 * 'own_presence')`), ou fizer as duas migrations divergirem no filtro, este teste cai —
 * exatamente a classe de bug que motivou R4 (own_presence esquecida na 467).
 */

import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'migrations');

const MIGRATION_468 = '468_grant_own_prefix_cells_catchup_new_groups.sql';
const MIGRATION_469 = '469_iam_create_group_grants_own_prefix_cells.sql';

// O filtro CANÔNICO: prefixo, nunca lista de resources literais.
const FILTRO_PREFIXO = "p.resource LIKE 'own\\_%' ESCAPE '\\'";

function lerMigration(nome: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, nome), 'utf8');
}

/** Remove linhas de comentário `--` antes de qualquer checagem de FORMA — o cabeçalho cita
 * `own_notifications`/`own_presence` em prosa (motivação), e isso não pode contar como o
 * SQL executável estar hardcoded. */
function semComentarios(sql: string): string {
  return sql
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('--'))
    .join('\n');
}

describe('R4 — regra de concessão own_* é derivada do catálogo por PREFIXO, não hardcoded', () => {
  it('as duas migrations da Rodada 4 existem', () => {
    for (const f of [MIGRATION_468, MIGRATION_469]) {
      expect([f, fs.existsSync(path.join(MIGRATIONS_DIR, f))]).toEqual([f, true]);
    }
  });

  it('468 (catch-up) usa o filtro de PREFIXO — não uma lista hardcoded de resources', () => {
    const sql = semComentarios(lerMigration(MIGRATION_468));
    expect(sql).toContain(FILTRO_PREFIXO);
    // Sabotagem clássica: trocar o prefixo por uma lista fixa passaria despercebido se o
    // teste só checasse "grants own_notifications". Aqui a FORMA proibida é auditada:
    expect(/resource\s+(=|IN\s*\()\s*'?own_(notifications|presence)/i.test(sql)).toBe(false);
  });

  it('469 (create_group) usa O MESMO filtro de PREFIXO — nenhuma deriva entre as duas migrations', () => {
    const sql = semComentarios(lerMigration(MIGRATION_469));
    expect(sql).toContain(FILTRO_PREFIXO);
    expect(/resource\s+(=|IN\s*\()\s*'?own_(notifications|presence)/i.test(sql)).toBe(false);
  });

  it('469 concede pelo id do grupo RECÉM-CRIADO (v_id) — nunca um id fixo nem JOIN com permission_groups', () => {
    // Contraste deliberado com a forma auditada da 436 (Master): lá o alvo é a constante
    // v_master_id, sem JOIN. Aqui o alvo tem de ser a variável do grupo que a própria
    // função acabou de criar — sabotagem óbvia seria "conceder a todos" via CROSS JOIN
    // com iam.permission_groups dentro do create_group, o que afetaria grupos ALHEIOS
    // toda vez que qualquer grupo fosse criado.
    const sql = semComentarios(lerMigration(MIGRATION_469));
    expect(sql).toMatch(
      /INSERT\s+INTO\s+iam\.group_permissions\s*\(group_id,\s*permission_id\)\s*SELECT\s+v_id,\s*p\.id\s*FROM\s+iam\.permissions\s+p/i,
    );
    expect(/CROSS\s+JOIN\s+iam\.permission_groups/i.test(sql)).toBe(false);
  });

  it('468 concede a TODO grupo ATIVO via CROSS JOIN — sem citar nenhum id de grupo específico', () => {
    const sql = semComentarios(lerMigration(MIGRATION_468));
    expect(sql).toMatch(
      /CROSS\s+JOIN\s+iam\.permissions\s+p\s*[\s\S]*?WHERE\s+g\.archived_at\s+IS\s+NULL/i,
    );
    // Nenhum UUID literal de grupo semeado (seed 206) — a regra tem de valer para
    // QUALQUER grupo ativo, não uma lista de ids conhecidos.
    expect(/a0000000-0000-0000-0000-00000000000\d/.test(sql)).toBe(false);
  });

  it('468 nunca concede a grupo arquivado nem faz DELETE (só ON CONFLICT DO NOTHING)', () => {
    const sql = semComentarios(lerMigration(MIGRATION_468));
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(/DELETE\s+FROM\s+(iam\.)?group_permissions/i.test(sql)).toBe(false);
  });

  it('469 preserva a assinatura e o gate `_require_manager` de iam.create_group (279)', () => {
    const sql = semComentarios(lerMigration(MIGRATION_469));
    expect(sql).toContain('CREATE OR REPLACE FUNCTION iam.create_group(p_tenant_id UUID, p_name TEXT, p_description TEXT)');
    expect(sql).toContain('iam._require_manager(p_tenant_id)');
  });
});
