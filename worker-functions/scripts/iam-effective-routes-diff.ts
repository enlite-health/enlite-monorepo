/**
 * scripts/iam-effective-routes-diff.ts — spec 018, PR-8b (8b.2/8b.6), ADR-2/SUP-30.
 *
 * Fotografa, POR GRUPO não-arquivado, o conjunto de (método, rota) que o grupo consegue
 * hoje — cruzando o inventário de rotas × ação declarada (`/.well-known/permissions/routes`,
 * o MESMO inventário que `SyncPermissionCatalogUseCase` consome e que
 * `permission-route-inventory.test.ts` já audita) com as células que o grupo tem
 * (`iam.group_permissions` × `iam.permissions`, a MESMA fonte que `PgIamConfigRepository.
 * exportSnapshot` usa — sem reescrever a query, só o recorte por grupo em vez de por tenant).
 *
 * Por que NÃO usa `iam.effective_permissions(uid, tenant)`: essa função é por STAFF (filtra
 * `users.status='ACTIVE'`, vínculo vivo) — este script quer o grant do GRUPO em si, para medir
 * o efeito da CONVERSÃO DE GRANTS (migration 435) sem depender de ter um usuário de teste em
 * cada grupo. `iam.group_permissions ⋈ iam.permissions` é exatamente o que
 * `iam.effective_permissions` faz por dentro, menos os joins de `user_groups`/`users`.
 *
 * Uso:
 *   API_URL=http://localhost:8080 DATABASE_URL=<alvo> \
 *     npx ts-node -r tsconfig-paths/register scripts/iam-effective-routes-diff.ts --out evidencias/8b-antes.json
 *
 *   API_URL=http://localhost:8080 DATABASE_URL=<alvo> \
 *     npx ts-node -r tsconfig-paths/register scripts/iam-effective-routes-diff.ts --antes evidencias/8b-antes.json
 *
 * V1 (8b.2/8b.6): compara o CONJUNTO de rotas permitidas por grupo entre duas fotos — "0
 * diferenças" é o que prova que a rodada (catalog split A1, ou o 8b.4 de rotas mais adiante)
 * não moveu acesso de ninguém. Nesta rodada (A1) as rotas continuam pedindo `write` — a
 * foto ANTES e a foto DEPOIS desta migration têm que bater exatamente porque nenhuma rota
 * mudou o que exige.
 */
import { writeFileSync, readFileSync } from 'fs';
import { Pool } from 'pg';
import { argValue } from './lib/cliArgs';

interface RotaGovernada {
  method: string;
  path: string;
  cell: string | null;
  status: string;
}

interface InventarioRotas {
  totalRoutes: number;
  governedRoutes: RotaGovernada[];
}

interface GrupoLinha {
  id: string;
  name: string;
}

export interface FotoRotas {
  geradoEm: string;
  totalGrupos: number;
  totalRotasGovernadas: number;
  /** grupo → lista ordenada "METHOD path", só as rotas que o grupo consegue chamar hoje. */
  rotasPorGrupo: Record<string, string[]>;
}

/** Pura — separada do I/O para poder ser testada sem rede nem banco. */
export function rotasPermitidasPorGrupo(
  rotas: RotaGovernada[],
  gruposComCelulas: Array<{ name: string; cells: Set<string> }>,
): Record<string, string[]> {
  const governadas = rotas.filter((r) => r.status === 'declared' && r.cell);
  const out: Record<string, string[]> = {};
  for (const grupo of gruposComCelulas) {
    const permitidas = governadas
      .filter((r) => grupo.cells.has(r.cell as string))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    out[grupo.name] = permitidas;
  }
  return out;
}

/** Diferença por grupo entre duas fotos — `added`/`removed` vazios nos dois = grupo intacto. */
export interface DiferencaGrupo {
  group: string;
  added: string[];
  removed: string[];
}

export function diffFotos(antes: FotoRotas, depois: FotoRotas): DiferencaGrupo[] {
  const nomes = new Set([...Object.keys(antes.rotasPorGrupo), ...Object.keys(depois.rotasPorGrupo)]);
  const diffs: DiferencaGrupo[] = [];
  for (const nome of nomes) {
    const a = new Set(antes.rotasPorGrupo[nome] ?? []);
    const d = new Set(depois.rotasPorGrupo[nome] ?? []);
    const added = [...d].filter((r) => !a.has(r)).sort();
    const removed = [...a].filter((r) => !d.has(r)).sort();
    if (added.length > 0 || removed.length > 0) diffs.push({ group: nome, added, removed });
  }
  return diffs.sort((x, y) => (x.group < y.group ? -1 : x.group > y.group ? 1 : 0));
}

async function buscarInventario(apiUrl: string, internalSecret: string): Promise<InventarioRotas> {
  const res = await fetch(`${apiUrl}/.well-known/permissions/routes`, { headers: { 'X-Internal-Secret': internalSecret } });
  if (res.status !== 200) throw new Error(`inventário de rotas: HTTP ${res.status} (secret certo? API de pé?)`);
  return (await res.json()) as InventarioRotas;
}

async function buscarGruposComCelulas(pool: Pool, tenantId: string): Promise<Array<{ name: string; cells: Set<string> }>> {
  const grupos = await pool.query<GrupoLinha>(
    `SELECT id, name FROM iam.permission_groups WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY name`,
    [tenantId],
  );
  const cells = await pool.query<{ group_id: string; key: string }>(
    `SELECT gp.group_id, po.resource || ':' || po.action AS key
       FROM iam.group_permissions gp JOIN iam.permissions po ON po.id = gp.permission_id
      WHERE gp.group_id = ANY($1) AND po.deprecated_at IS NULL`,
    [grupos.rows.map((g) => g.id)],
  );
  return grupos.rows.map((g) => ({
    name: g.name,
    cells: new Set(cells.rows.filter((c) => c.group_id === g.id).map((c) => c.key)),
  }));
}

async function main(): Promise<void> {
  const apiUrl = process.env.API_URL || 'http://localhost:8080';
  const internalSecret = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
  const tenantId = argValue('--tenant') ?? '00000000-0000-0000-0000-000000000001';
  const out = argValue('--out');
  const antesPath = argValue('--antes');
  if (!out && !antesPath) throw new Error('use --out <arquivo> para gravar a foto, ou --antes <arquivo> para comparar');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const [inventario, grupos] = await Promise.all([
      buscarInventario(apiUrl, internalSecret),
      buscarGruposComCelulas(pool, tenantId),
    ]);
    const rotasPorGrupo = rotasPermitidasPorGrupo(inventario.governedRoutes, grupos);
    const totalRotasGovernadas = inventario.governedRoutes.filter((r) => r.status === 'declared' && r.cell).length;
    const foto: FotoRotas = {
      geradoEm: new Date().toISOString(),
      totalGrupos: grupos.length,
      totalRotasGovernadas,
      rotasPorGrupo,
    };

    if (out) {
      writeFileSync(out, JSON.stringify(foto, null, 2) + '\n');
      console.log(`[iam-effective-routes-diff] grupos: ${foto.totalGrupos}, rotas governadas: ${foto.totalRotasGovernadas} → ${out}`);
      return;
    }

    const antes = JSON.parse(readFileSync(antesPath as string, 'utf8')) as FotoRotas;
    const diffs = diffFotos(antes, foto);
    if (diffs.length === 0) {
      console.log(`[iam-effective-routes-diff] 0 diferenças (${foto.totalGrupos} grupos, antes=${antes.totalGrupos})`);
      return;
    }
    console.error(`[iam-effective-routes-diff] ${diffs.length} grupo(s) com diferença:`);
    for (const d of diffs) {
      console.error(`  ${d.group}: +${d.added.length} -${d.removed.length}`);
      for (const r of d.added) console.error(`    + ${r}`);
      for (const r of d.removed) console.error(`    - ${r}`);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[iam-effective-routes-diff] falhou:', e.message); process.exit(1); });
}
