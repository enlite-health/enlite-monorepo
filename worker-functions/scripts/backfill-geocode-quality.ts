/**
 * backfill-geocode-quality.ts — spec 077, F1 (T270).
 *
 * Preenche `geocode_quality` / `geocode_partial_match` / `geocoded_at` (migration 582) nos endereços
 * VIVOS de `patient_addresses` que ainda não foram classificados. NUNCA toca `lat`/`lng`.
 *
 * 🔒 `--dry-run` é o PADRÃO: só `SELECT count(*)`, nenhuma chamada ao Google, nenhum UPDATE.
 * `--execute` é explícito e GASTA chamadas da Geocoding API (≈1.004 endereços vivos; dentro dos 10k/mês
 * gratuitos). A execução em prd é do Gabriel, presente.
 *
 * "Vivo" = `archived_at IS NULL` (a coluna real de `patient_addresses`, migration 198; não há `deleted_at`).
 * Candidato = vivo + `geocode_quality IS NULL AND geocode_partial_match IS NULL` + texto geocodificável.
 * Idempotente: depois de gravado, a linha sai do conjunto de candidatos.
 *
 * D685 (15/11): antes de gravar, compara a coordenada que o Google devolve com a GRAVADA.
 *   - até `LIMIAR_DIVERGENCIA_M` (100 m): grava a qualidade;
 *   - acima disso: não grava, conta `longe` e lista o `address_id`;
 *   - sem coordenada gravada: não chama o Google, não grava, conta `sem_coordenada` e lista o `address_id`.
 * O dry-run não chama o Google: conta quantos seriam consultados e quantos estão sem coordenada.
 *
 * Uso:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-geocode-quality.ts                    # dry-run
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register scripts/backfill-geocode-quality.ts --execute --limit 100
 *
 * Env: DATABASE_URL (pool) · GOOGLE_MAPS_API_KEY (só em --execute; lida pelo GeocodingService).
 * Log: só contagens e `address_id` — nunca endereço nem coordenada (nem a gravada, nem a do Google).
 */
import { Pool } from 'pg';
import { assertBackfillWriteTarget } from '../src/shared/database/assertLocalDatabaseTarget';
import { GeocodingService } from '../src/infrastructure/services/GeocodingService';
import { geocodePatientAddressesBestEffort } from '../src/modules/case/infrastructure/geocodePatientAddresses';
import { haversineDistanceKm } from '../src/modules/case/infrastructure/backfillPatientAddressLocation';

/** D685: até este raio a qualidade nova descreve o ponto gravado; acima, não grava. */
export const LIMIAR_DIVERGENCIA_M = 100;

export interface BackfillOpts {
  execute: boolean;
  limit: number;
  /** Pausa entre endereços (rate limit do Google). Testes passam 0. */
  delayMs?: number;
  /** Teto por endereço no geocoder (default 15000). */
  timeoutMs?: number;
  /** `--eu-sei-que-e-producao`: autoriza alvo não-local (mesma trava dos backfills 2.4/3/4.2). */
  producaoAutorizada?: boolean;
}

export interface BackfillDeps {
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
  geocoder: Pick<GeocodingService, 'geocodeBatch'>;
  /** Valor da chave da API (só a presença é conferida aqui; o geocoder a lê do env). */
  apiKey?: string;
  /** DATABASE_URL — alvo conferido pela trava antes de `--execute`. */
  databaseUrl?: string;
  log?: (msg: string) => void;
}

export interface BackfillResult {
  mode: 'dry-run' | 'execute';
  candidates: number;
  updated: number;
  failed: number;
  /** Google devolveu um ponto a mais de `LIMIAR_DIVERGENCIA_M` da coordenada gravada: não gravou. */
  far: number;
  /** Sem `lat`/`lng` gravados: não chamou o Google, não gravou. */
  noCoords: number;
  aborted?: string;
}

const CANDIDATE_WHERE = `archived_at IS NULL
        AND geocode_quality IS NULL
        AND geocode_partial_match IS NULL
        AND (NULLIF(TRIM(address_formatted), '') IS NOT NULL OR NULLIF(TRIM(address_raw), '') IS NOT NULL)`;

export const travaDeAlvo = assertBackfillWriteTarget;

export const HELP = `Uso: backfill-geocode-quality.ts [--dry-run] [--execute] [--eu-sei-que-e-producao] [--limit N] [--help]
  --dry-run   (PADRÃO) só conta os candidatos; nada é chamado, nada é gravado
  --execute   chama o Google por endereço COM coordenada e grava geocode_quality/geocode_partial_match/geocoded_at
              só se o ponto do Google estiver a até 100 m do gravado (acima: lista o id e não grava)
  --eu-sei-que-e-producao
              obrigatória em --execute contra banco NÃO-local (trava de alvo; dry-run não passa por ela)
  --limit N   máximo de endereços por execução (default 100)
  --help      esta ajuda
Env: DATABASE_URL; GOOGLE_MAPS_API_KEY (obrigatória em --execute). Nunca reescreve lat/lng.`;

export function parseArgs(argv: string[]): BackfillOpts & { help: boolean } {
  const i = argv.indexOf('--limit');
  const raw = i >= 0 ? Number(argv[i + 1]) : 100;
  const limit = Number.isInteger(raw) && raw > 0 ? raw : 100;
  return { execute: argv.includes('--execute'), producaoAutorizada: argv.includes('--eu-sei-que-e-producao'), limit, help: argv.includes('--help') };
}

export async function runBackfill(deps: BackfillDeps, opts: BackfillOpts): Promise<BackfillResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const { pool, geocoder } = deps;

  if (!opts.execute) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, (count(*) FILTER (WHERE lat IS NULL OR lng IS NULL))::int AS sem
         FROM patient_addresses WHERE ${CANDIDATE_WHERE}`,
    );
    const n = Number(rows[0]?.n ?? 0);
    const sem = Number(rows[0]?.sem ?? 0);
    log(`${n} endereços sem geocode_quality (dry-run: nada chamado, nada gravado)`);
    log(`DRY a_consultar=${n - sem} sem_coordenada=${sem}`);
    return { mode: 'dry-run', candidates: n, updated: 0, failed: 0, far: 0, noCoords: sem };
  }

  try {
    travaDeAlvo(deps.databaseUrl, opts.producaoAutorizada === true);
  } catch (e) {
    const aborted = e instanceof Error ? e.message : String(e);
    log(aborted);
    return { mode: 'execute', candidates: 0, updated: 0, failed: 0, far: 0, noCoords: 0, aborted };
  }

  if (!deps.apiKey) {
    const aborted = 'GOOGLE_MAPS_API_KEY ausente — abortando --execute (nada chamado, nada gravado)';
    log(aborted);
    return { mode: 'execute', candidates: 0, updated: 0, failed: 0, far: 0, noCoords: 0, aborted };
  }

  const { rows } = await pool.query(
    `SELECT id, address_formatted, address_raw, neighborhood, city, state, lat, lng
       FROM patient_addresses
      WHERE ${CANDIDATE_WHERE}
      ORDER BY (lat IS NULL OR lng IS NULL), created_at ASC, id
      LIMIT $1`,
    [opts.limit],
  );

  const res: BackfillResult = { mode: 'execute', candidates: rows.length, updated: 0, failed: 0, far: 0, noCoords: 0 };
  for (const row of rows) {
    if (row.lat == null || row.lng == null) {
      res.noCoords++;
      log(`sem_coordenada address_id=${row.id}`);
      continue;
    }
    try {
      const [g] = await geocodePatientAddressesBestEffort(
        [{
          displayOrder: 0,
          addressFormatted: row.address_formatted,
          addressRaw: row.address_raw,
          neighborhood: row.neighborhood,
          city: row.city,
          state: row.state,
        }],
        geocoder as GeocodingService,
        { delayMs: 0, timeoutMs: opts.timeoutMs ?? 15000 },
      );
      if (!g || g.geocode_quality == null || g.geocode_partial_match == null || g.lat == null || g.lng == null) {
        res.failed++;
        log(`falha address_id=${row.id}`);
      } else if (!(haversineDistanceKm(Number(row.lat), Number(row.lng), g.lat, g.lng) * 1000 <= LIMIAR_DIVERGENCIA_M)) {
        res.far++;
        log(`longe address_id=${row.id}`);
      } else {
        // Só os 3 campos de qualidade — lat/lng ficam intactos.
        await pool.query(
          'UPDATE patient_addresses SET geocode_quality = $1, geocode_partial_match = $2, geocoded_at = $3 WHERE id = $4',
          [g.geocode_quality, g.geocode_partial_match, g.geocoded_at ?? new Date(), row.id],
        );
        res.updated++;
        log(`gravado address_id=${row.id}`);
      }
    } catch {
      res.failed++;
      log(`falha address_id=${row.id}`);
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
  }
  log(`DONE candidatos=${res.candidates} gravados=${res.updated} falhas=${res.failed} longe=${res.far} sem_coordenada=${res.noCoords}`);
  return res;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente — abortando.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await runBackfill(
      { pool, geocoder: new GeocodingService(), apiKey: process.env.GOOGLE_MAPS_API_KEY, databaseUrl: process.env.DATABASE_URL },
      { execute: args.execute, producaoAutorizada: args.producaoAutorizada, limit: args.limit, delayMs: 200 },
    );
    if (r.aborted) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill-geocode-quality] FATAL:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
