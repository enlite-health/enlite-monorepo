/**
 * AdminPatientsMapController
 *
 * POST /api/admin/patients/map — os pontos do mapa de pacientes (REQ-04 da
 * planning de 26/08, DEC-14: "el mapita de pacientes").
 *
 * POST com corpo, não GET (lex 29/08, C2): o centro do raio é a casa de
 * alguém e a URL crua vai para o log do Cloud Run. Escopo obrigatório (C3):
 * centro+raio ou província/localidade — sem escopo é export da base, 400.
 * País como parâmetro (C4).
 *
 * UM ponto por ENDEREÇO ativo (`patient_addresses.archived_at IS NULL`): um
 * paciente pode ter mais de um domicílio, e é o domicílio que o recrutador
 * cruza com a posição dos prestadores. Paciente sem endereço (ou sem
 * coordenada) continua na resposta com `lat`/`lng` nulos — "não sei onde
 * está" nunca some por causa de um raio.
 *
 * ⚠️ PRIVACIDADE (regra dura + lex C1): o SELECT NÃO traz coluna clínica
 * nenhuma — sem `diagnosis`, sem `additional_comments`, sem `dependency_level`
 * — e o schema é `.strict()`: filtro clínico (`clinical_specialty`,
 * `dependency_level`, `attention_reason`…) é 400, porque um mapa filtrado por
 * patologia é um mapa clínico. O pino é nome + status + endereço + nº de vagas
 * abertas. Há teste que falha se uma dessas colunas aparecer no SQL.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError } from '@shared/logging';
import { PATIENT_STATUSES } from '../../domain/enums/PatientStatus';

export const MAX_PATIENT_MAP_POINTS = 5000;

/** Vaga "aberta" para o mapa = ainda procurando gente. Mesma família da lista de vagas. */
export const OPEN_VACANCY_STATUSES = ['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE'] as const;

const coord = (min: number, max: number) => z.number().min(min).max(max);
const text = z.string().trim().min(1).max(120);

export const PatientsMapBodySchema = z
  .object({
    country: z.enum(['AR', 'BR']),
    /** Status de paciente. Ausente = todos (o filtro é da tela). */
    status: z.array(z.enum(PATIENT_STATUSES as unknown as [string, ...string[]])).optional(),
    state: text.optional(),
    city: text.optional(),
    /** true → só pacientes com ao menos uma vaga aberta. */
    with_open_vacancies: z.boolean().optional(),
    center: z.object({ lat: coord(-90, 90), lng: coord(-180, 180) }).strict().optional(),
    radius_km: z.number().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(MAX_PATIENT_MAP_POINTS).default(MAX_PATIENT_MAP_POINTS),
  })
  .strict()
  .refine((q) => q.radius_km === undefined || q.center !== undefined, {
    message: 'radius_km requires center',
  })
  .refine(
    (q) => (q.center !== undefined && q.radius_km !== undefined) || q.state !== undefined || q.city !== undefined,
    { message: 'scope required: center+radius_km, or state/city' },
  );

export type PatientsMapBody = z.infer<typeof PatientsMapBodySchema>;

export interface PatientMapPoint {
  id: string;
  addressId: string | null;
  name: string;
  lat: number | null;
  lng: number | null;
  status: string;
  addressType: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  openVacancies: number;
  distanceKm: number | null;
}

interface PatientMapRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
  address_id: string | null;
  address_type: string | null;
  lat: string | number | null;
  lng: string | number | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  open_vacancies: string | number;
  distance_km: string | number | null;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Monta o SQL do mapa. Exportada para o teste afirmar a forma (e a AUSÊNCIA de coluna clínica). */
export function buildPatientsMapQuery(q: PatientsMapBody): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let i = 1;
  const conds: string[] = ['p.deleted_at IS NULL'];

  conds.push(`p.country = $${i}`);
  params.push(q.country);
  i++;

  if (q.status && q.status.length > 0) {
    conds.push(`p.status = ANY($${i}::text[])`);
    params.push(q.status);
    i++;
  }
  if (q.state) {
    conds.push(`lower(btrim(pa.state)) = lower(btrim($${i}))`);
    params.push(q.state);
    i++;
  }
  if (q.city) {
    conds.push(`lower(btrim(pa.city)) = lower(btrim($${i}))`);
    params.push(q.city);
    i++;
  }

  const openVacancies = `(
    SELECT COUNT(*) FROM job_postings jp
    WHERE jp.patient_id = p.id AND jp.deleted_at IS NULL
      AND jp.status = ANY($${i}::text[])
  )::int`;
  params.push([...OPEN_VACANCY_STATUSES]);
  i++;
  if (q.with_open_vacancies === true) conds.push(`${openVacancies} > 0`);

  const point = 'ST_SetSRID(ST_MakePoint(pa.lng, pa.lat), 4326)::geography';
  let distanceSelect = 'NULL::numeric AS distance_km';
  if (q.center) {
    const pLng = i++;
    const pLat = i++;
    params.push(q.center.lng, q.center.lat);
    const center = `ST_SetSRID(ST_MakePoint($${pLng}, $${pLat}), 4326)::geography`;
    distanceSelect = `CASE WHEN pa.lat IS NULL OR pa.lng IS NULL THEN NULL
      ELSE ST_Distance(${point}, ${center}) / 1000.0 END AS distance_km`;
    if (q.radius_km !== undefined) {
      const pM = i++;
      params.push(q.radius_km * 1000);
      conds.push(`(pa.lat IS NULL OR pa.lng IS NULL OR ST_DWithin(${point}, ${center}, $${pM}))`);
    }
  }

  const pLimit = i++;
  params.push(q.limit);

  const sql = `
    SELECT p.id, p.first_name, p.last_name, p.status,
      pa.id AS address_id, pa.address_type, pa.lat, pa.lng, pa.city, pa.neighborhood, pa.state,
      ${openVacancies} AS open_vacancies,
      ${distanceSelect}
    FROM patients p
    LEFT JOIN patient_addresses pa ON pa.patient_id = p.id AND pa.archived_at IS NULL
    WHERE ${conds.join('\n      AND ')}
    ORDER BY distance_km ASC NULLS LAST, p.last_name ASC, p.first_name ASC, pa.display_order ASC
    LIMIT $${pLimit}
  `;
  return { sql, params };
}

export class AdminPatientsMapController {
  private readonly db = DatabaseConnection.getInstance().getPool();

  /** POST /api/admin/patients/map */
  async getMapPoints(req: Request, res: Response): Promise<void> {
    const parsed = PatientsMapBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid map filters', details: parsed.error.flatten() });
      return;
    }

    try {
      const { sql, params } = buildPatientsMapQuery(parsed.data);
      const result = await this.db.query<PatientMapRow>(sql, params);

      const data: PatientMapPoint[] = result.rows.map((row) => {
        const lat = num(row.lat);
        const lng = num(row.lng);
        const hasCoords = lat !== null && lng !== null;
        return {
          id: row.id,
          addressId: row.address_id ?? null,
          name: [row.first_name, row.last_name].filter(Boolean).join(' ') || '—',
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          status: row.status,
          addressType: row.address_type ?? null,
          city: row.city ?? null,
          neighborhood: row.neighborhood ?? null,
          state: row.state ?? null,
          openVacancies: num(row.open_vacancies) ?? 0,
          distanceKm: hasCoords ? num(row.distance_km) : null,
        };
      });

      const withoutCoordinates = data.filter((p) => p.lat === null).length;
      const truncated = data.length >= parsed.data.limit;

      // Trilha de leitura em massa (lex C5): sem coordenada, nome ou UUID. Tabela da OP-08 vem com o ABAC (D212).
      logger.info({
        msg: 'patients.map.read',
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
      reportError(e, { source: 'AdminPatientsMapController:getMapPoints' });
      res.status(500).json({ success: false, error: 'Failed to load patients map' });
    }
  }
}
