/**
 * AdminWorkersMapController
 *
 * POST /api/admin/workers/map — os pontos do mapa de prestadores (REQ-04 da
 * planning de 26/08, DEC-14: "dois mapas sobre o Google").
 *
 * É POST com corpo, e não GET com query, de propósito (lex 29/08, C2): o
 * Cloud Run grava a URL crua da request num log global por 30 dias, e o
 * centro do raio é a casa de alguém. Coordenada não vai na URL.
 *
 * Diferente de GET /workers, aqui NÃO há paginação: o mapa precisa de todos
 * os pontos que casam o filtro — mas o filtro tem ESCOPO OBRIGATÓRIO (lex C3):
 * centro+raio ou província/localidade. Sem escopo é export da base, e a
 * resposta é 400. O WHERE reaproveita o da lista (`buildWorkerListWhereClause`)
 * para "documentação completa", profissão e província/localidade significarem
 * a mesma coisa nas duas telas; por cima entra o raio (`ST_DWithin` sobre
 * `worker_service_areas.location`) e o país (lex C4).
 *
 * Quem NÃO tem coordenada continua na resposta com `lat`/`lng` nulos: o
 * recrutador precisa saber que aquela pessoa existe e não está no mapa
 * (medido em prod, 29/08: 1213 de 3400 INCOMPLETE_REGISTER têm coordenada).
 * Um raio nunca esconde quem não tem posição — "não sei onde está" ≠ "está longe".
 *
 * Privacidade: sai nome, status, profissão, cidade/bairro e posição. Nada de
 * telefone, e-mail, documento. A leitura em massa deixa trilha (lex C5):
 * uid, país, escopo e contagens — sem coordenada, sem nome.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { logger, reportError } from '@shared/logging';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { buildAllValidatedClause, buildPendingValidationClause } from '../../application/workerDocumentFilters';
import { buildWorkerListWhereClause } from './AdminWorkersListHelpers';

export const MAX_MAP_POINTS = 5000;
/** Decrypt em lotes: em prod cada nome é uma chamada ao KMS. */
const DECRYPT_BATCH = 25;

const WorkerStatusEnum = z.enum(['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED']);

const coord = (min: number, max: number) => z.number().min(min).max(max);
const text = z.string().trim().min(1).max(120);

/** `.strict()`: parâmetro desconhecido é 400, não silêncio (lex C1). */
export const WorkersMapBodySchema = z
  .object({
    country: z.enum(['AR', 'BR']),
    /** Lista de status. Ausente = REGISTERED + INCOMPLETE_REGISTER (quem deu baixa fica fora). */
    status: z.array(WorkerStatusEnum).optional(),
    docs_complete: z.enum(['complete', 'incomplete']).optional(),
    docs_validated: z.enum(['all_validated', 'pending_validation']).optional(),
    /** AT,CAREGIVER,NURSE,KINESIOLOGIST,PSYCHOLOGIST */
    profession: z.array(z.string().trim().min(1)).optional(),
    state: text.optional(),
    city: text.optional(),
    center: z.object({ lat: coord(-90, 90), lng: coord(-180, 180) }).strict().optional(),
    radius_km: z.number().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(MAX_MAP_POINTS).default(MAX_MAP_POINTS),
  })
  .strict()
  .refine((q) => q.radius_km === undefined || q.center !== undefined, {
    message: 'radius_km requires center',
  })
  .refine((q) => hasScope(q), {
    message: 'scope required: center+radius_km, or state/city',
  });

export type WorkersMapBody = z.infer<typeof WorkersMapBodySchema>;

function hasScope(q: { center?: unknown; radius_km?: number; state?: string; city?: string }): boolean {
  return (q.center !== undefined && q.radius_km !== undefined) || q.state !== undefined || q.city !== undefined;
}

export interface WorkerMapPoint {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  status: string;
  documentsComplete: boolean;
  profession: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  /** Só quando a request trouxe centro; null para quem não tem coordenada. */
  distanceKm: number | null;
}

interface WorkerMapRow {
  id: string;
  email: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  status: string;
  profession: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  distance_km: string | number | null;
}

const DEFAULT_STATUSES = ['REGISTERED', 'INCOMPLETE_REGISTER'];

function num(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Monta o SQL do mapa. Exportada para o teste afirmar a forma da query
 * (a régua aqui é o TEXTO do SQL + a ordem dos params, porque o banco real
 * só entra no e2e).
 */
export function buildWorkersMapQuery(q: WorkersMapBody): { sql: string; params: unknown[] } {
  // `status` da lista aceita UM valor; o mapa aceita vários. Chamo o builder
  // SEM status (ele então exclui DISABLED, a regra da casa) e aplico o ANY por
  // cima. Só quando o pedido inclui DISABLED explicitamente — "quem deu baixa
  // também" — o exclude da casa daria contradição, e é trocado por TRUE.
  const statuses = q.status && q.status.length > 0 ? q.status : DEFAULT_STATUSES;
  const base = buildWorkerListWhereClause({
    docs_complete: q.docs_complete,
    profession: q.profession?.join(','),
    state: q.state,
    city: q.city,
    limit: String(q.limit),
    offset: '0',
  });

  let where = base.whereClause;
  const params = [...base.params];
  let i = base.paramIndex;

  if (statuses.includes('DISABLED')) {
    where = where.replace(excludeDisabledWorkersSql('w'), 'TRUE');
  }
  where += ` AND w.status = ANY($${i}::text[])`;
  params.push(statuses);
  i++;

  where += ` AND w.country = $${i}`;
  params.push(q.country);
  i++;

  if (q.docs_validated === 'all_validated') where += ` AND ${buildAllValidatedClause('wd')}`;
  if (q.docs_validated === 'pending_validation') where += ` AND ${buildPendingValidationClause('wd')}`;

  let distanceSelect = 'NULL::numeric AS distance_km';
  if (q.center) {
    const pLng = i++;
    const pLat = i++;
    params.push(q.center.lng, q.center.lat);
    const point = `ST_SetSRID(ST_MakePoint($${pLng}, $${pLat}), 4326)::geography`;
    distanceSelect = `ST_Distance(wsa.location, ${point}) / 1000.0 AS distance_km`;
    if (q.radius_km !== undefined) {
      const pM = i++;
      params.push(q.radius_km * 1000);
      // Sem coordenada NÃO é "fora do raio": fica na resposta com lat/lng nulos.
      where += ` AND (wsa.location IS NULL OR ST_DWithin(wsa.location, ${point}, $${pM}))`;
    }
  }

  const pLimit = i++;
  params.push(q.limit);

  const sql = `
    SELECT w.id, w.email, w.first_name_encrypted, w.last_name_encrypted, w.status, w.profession,
      wsa.latitude, wsa.longitude, wsa.city, wsa.neighborhood, wsa.state,
      ${distanceSelect}
    FROM workers w
    LEFT JOIN worker_documents wd ON wd.worker_id = w.id
    LEFT JOIN LATERAL (
      SELECT s.latitude, s.longitude, s.location, s.city, s.neighborhood, s.state
      FROM worker_service_areas s
      WHERE s.worker_id = w.id AND s.deleted_at IS NULL
      ORDER BY (s.latitude IS NULL), s.updated_at DESC
      LIMIT 1
    ) wsa ON true
    ${where}
    ORDER BY distance_km ASC NULLS LAST, w.created_at DESC
    LIMIT $${pLimit}
  `;
  return { sql, params };
}

async function mapInBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += size) {
    const chunk = items.slice(start, start + size);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

export class AdminWorkersMapController {
  private readonly db = DatabaseConnection.getInstance().getPool();
  private readonly encryption = new KMSEncryptionService();

  /** POST /api/admin/workers/map */
  async getMapPoints(req: Request, res: Response): Promise<void> {
    const parsed = WorkersMapBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid map filters', details: parsed.error.flatten() });
      return;
    }

    try {
      const { sql, params } = buildWorkersMapQuery(parsed.data);
      const result = await this.db.query<WorkerMapRow>(sql, params);

      const data = await mapInBatches(result.rows, DECRYPT_BATCH, async (row): Promise<WorkerMapPoint> => {
        const [firstName, lastName] = await Promise.all([
          this.encryption.decrypt(row.first_name_encrypted),
          this.encryption.decrypt(row.last_name_encrypted),
        ]);
        const lat = num(row.latitude);
        const lng = num(row.longitude);
        const hasCoords = lat !== null && lng !== null;
        return {
          id: row.id,
          name: [firstName, lastName].filter(Boolean).join(' ') || row.email,
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          status: row.status,
          documentsComplete: row.status === 'REGISTERED',
          profession: row.profession ?? null,
          city: row.city ?? null,
          neighborhood: row.neighborhood ?? null,
          state: row.state ?? null,
          distanceKm: hasCoords ? num(row.distance_km) : null,
        };
      });

      const withoutCoordinates = data.filter((p) => p.lat === null).length;
      const truncated = data.length >= parsed.data.limit;

      // Trilha de leitura em massa (lex C5): quem, país, escopo, quantos. Sem
      // coordenada, sem nome, sem UUID. A tabela da OP-08 chega com o ABAC (D212).
      logger.info({
        msg: 'workers.map.read',
        uid: req.user?.uid ?? null,
        country: parsed.data.country,
        scope: parsed.data.center ? 'radius' : 'location',
        n: data.length,
        withoutCoordinates,
        truncated,
      });

      res.status(200).json({ success: true, data, total: data.length, withoutCoordinates, truncated });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      // Só a origem: nenhuma coordenada, nome ou filtro vai para o log.
      reportError(e, { source: 'AdminWorkersMapController:getMapPoints' });
      res.status(500).json({ success: false, error: 'Failed to load workers map' });
    }
  }
}
