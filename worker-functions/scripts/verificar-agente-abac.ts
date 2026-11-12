/**
 * scripts/verificar-agente-abac.ts — verificador do invariante de subconjunto do agente no ABAC (spec 078, M2, item 36).
 *
 *   células(capabilities do agente) ⊆ células(grupo AGENT)  ⊆  células(grupo humano espelho)
 *   e nenhuma `permission_management:*` / célula de lote no grupo AGENT (lida do BANCO: `iam.celulas_vedadas_a_agente()`).
 *
 * SÓ LEITURA (2 `SELECT` do contrato + 3 de apoio). Nunca cria, altera nem remove grupo ou célula. Não imprime e-mail, token nem ID de pessoa:
 * só o uid do agente (`agent:luz`), nomes de grupo e `recurso:ação`.
 *
 * Uso (host; leitura contra réplica/prd só com OK nomeado — M2.F.8):
 *   cd worker-functions && DATABASE_URL=<réplica ou prd read-only> npm run verificar:agente-abac -- --agente luz --espelho "Recrutador"
 *
 * Saída: uma linha `DIVERGE AGENTE <uid> <regra> <detalhe>` por violação, `AVISO AGENTE …` (não é divergência) e, no fim,
 * `N checagens executadas` + `rc=<n>`. rc 0 = nenhuma DIVERGE; rc 1 = ≥ 1; rc 2 = não conseguiu medir (conexão, espelho, N = 0):
 * falha, nunca sucesso (contagem zero ≠ "nada errado"). Contrato: `specs/078-pessoas-artificiais/contratos-M2/grupo-agent-e-verificador.md` §3.
 */
import { Pool } from 'pg';
import { AGENT_CAPABILITY_CELLS } from '@modules/mcp/domain/AgentCapabilityCells';
import { argValue } from './lib/cliArgs';

export interface ResultadoVerificacao {
  linhas: string[];
  checagens: number;
  rc: 0 | 1 | 2;
}

/** C1 do contrato: o agente e o(s) grupo(s) vivo(s) de que é membro. */
const C1 = `SELECT u.firebase_uid, u.status, g.id AS group_id, g.name, g.actor_class
  FROM users u
  JOIN iam.user_groups ug ON ug.user_id = u.firebase_uid AND ug.removed_at IS NULL
  JOIN iam.permission_groups g ON g.id = ug.group_id AND g.archived_at IS NULL
 WHERE u.account_type = 'agent' AND u.firebase_uid = $1`;

/** C2 do contrato: células vivas do grupo (mesma junção de `iam.effective_permissions`, 276). */
const C2 = `SELECT p.resource || ':' || p.action AS cell
  FROM iam.group_permissions gp
  JOIN iam.permissions p ON p.id = gp.permission_id AND p.deprecated_at IS NULL
 WHERE gp.group_id = $1
 ORDER BY 1`;

const CELULAS_VIVAS = `SELECT p.resource || ':' || p.action AS cell FROM iam.permissions p WHERE p.deprecated_at IS NULL`;

export async function verificarAgente(
  pool: Pick<Pool, 'query'>,
  opts: { agente: string; espelho: string; capabilities?: Readonly<Record<string, string>> },
): Promise<ResultadoVerificacao> {
  const uid = `agent:${opts.agente}`;
  const mapa = opts.capabilities ?? AGENT_CAPABILITY_CELLS;
  const linhas: string[] = [];
  let checagens = 0;
  const diverge = (regra: string, detalhe = ''): void => {
    linhas.push(`DIVERGE AGENTE ${uid} ${regra}${detalhe ? ` ${detalhe}` : ''}`);
  };
  const celulasDe = async (groupId: string): Promise<Set<string>> =>
    new Set((await pool.query<{ cell: string }>(C2, [groupId])).rows.map((r) => r.cell));

  try {
    // vedadas: lidas do banco (a mesma função que os triggers usam); `permission_management:*` vale por recurso (I5).
    const vedadas = new Set(
      ((await pool.query<{ v: string[] }>(`SELECT iam.celulas_vedadas_a_agente() AS v`)).rows[0]?.v ?? []) as string[],
    );
    const ehVedada = (cell: string): boolean => vedadas.has(cell) || cell.startsWith('permission_management:');

    const grupos = (await pool.query<{ status: string; group_id: string; name: string; actor_class: string }>(C1, [uid])).rows;
    checagens += 1;
    if (grupos.length === 0) {
      diverge('SEM_GRUPO');
      return fechar(linhas, checagens);
    }
    if (grupos[0].status !== 'ACTIVE') linhas.push(`AVISO AGENTE ${uid} AGENTE_INATIVO`);

    const espelhoRow = (
      await pool.query<{ id: string }>(`SELECT id FROM iam.permission_groups WHERE name = $1 AND archived_at IS NULL`, [opts.espelho])
    ).rows[0];
    checagens += 1;
    const celulasEspelho = espelhoRow ? await celulasDe(espelhoRow.id) : null;
    if (!celulasEspelho) diverge('ESPELHO_AUSENTE', opts.espelho);

    const uniao = new Set<string>();
    for (const g of grupos) {
      const celulas = await celulasDe(g.group_id);
      celulas.forEach((c) => uniao.add(c));
      checagens += 1;
      if (g.actor_class !== 'AGENT') diverge('GRUPO_NAO_AGENT', g.name);
      for (const c of celulas) {
        checagens += 1;
        if (ehVedada(c)) diverge('CELULA_VEDADA', c);
        if (celulasEspelho && !celulasEspelho.has(c)) diverge('GRUPO_FORA_DO_ESPELHO', c);
      }
    }

    const vivas = new Set((await pool.query<{ cell: string }>(CELULAS_VIVAS)).rows.map((r) => r.cell));
    const jaAcusada = new Set<string>();
    for (const [capability, cell] of Object.entries(mapa)) {
      checagens += 1;
      if (!vivas.has(cell) && !jaAcusada.has(cell)) {
        jaAcusada.add(cell);
        diverge('CELULA_DO_MAPA_SEM_CATALOGO', cell);
      }
      if (!uniao.has(cell)) diverge('CAPABILITY_FORA_DO_GRUPO', `${capability} ${cell}`);
    }
    return fechar(linhas, checagens);
  } catch (err) {
    linhas.push(`ERRO AGENTE ${uid} NAO_MEDIU ${err instanceof Error ? err.name : 'erro'}`);
    return { linhas, checagens, rc: 2 };
  }
}

function fechar(linhas: string[], checagens: number): ResultadoVerificacao {
  // checagens = 0 é falha, nunca sucesso.
  const rc = checagens === 0 ? 2 : linhas.some((l) => l.startsWith('DIVERGE')) ? 1 : 0;
  return { linhas, checagens, rc };
}

export function formatar(r: ResultadoVerificacao): string {
  return [...r.linhas, `${r.checagens} checagens executadas`, `rc=${r.rc}`].join('\n');
}

async function main(): Promise<number> {
  const agente = argValue('--agente');
  const espelho = argValue('--espelho');
  const url = process.env.DATABASE_URL;
  if (!agente || !espelho || !url) {
    console.error('uso: DATABASE_URL=… npm run verificar:agente-abac -- --agente luz --espelho "<nome do grupo humano>"  (sem default)');
    return 2;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const r = await verificarAgente(pool, { agente, espelho });
    console.log(formatar(r));
    return r.rc;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().then((rc) => process.exit(rc), () => process.exit(2));
}
