/**
 * AdminPatientsMapController
 *
 * POST /api/admin/patients/map — os pontos do mapa de pacientes (REQ-04 da
 * planning de 26/08, DEC-14: "el mapita de pacientes").
 *
 * POST com corpo, não GET (lex 29/08, C2): o centro do raio é a casa de
 * alguém e a URL crua vai para o log do Cloud Run. Escopo obrigatório (C3):
 * centro+raio ou província/localidade — sem escopo é export da base, 400.
 * País como parâmetro (C4). O que é comum aos dois mapas vive em
 * `@shared/http/mapQueryCommon`.
 *
 * UM ponto por ENDEREÇO ativo (`patient_addresses.archived_at IS NULL`): um
 * paciente pode ter mais de um domicílio, e é o domicílio que o recrutador
 * cruza com a posição dos prestadores. Paciente sem endereço (ou sem
 * coordenada) continua na resposta com `lat`/`lng` nulos — "não sei onde
 * está" nunca some por causa de um raio.
 *
 * "Vaga aberta" é a MESMA regra da lista de vagas e do dashboard
 * (`LIVE_JOB_POSTING_SQL`: status vivo, não rascunho, não apagada) — contada
 * UMA vez num LATERAL e reaproveitada no filtro e na coluna.
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
import {
  MAX_MAP_POINTS, mapScopeShape, num, parseMapBody, respondMapError, respondMapPoints, totalFromRows,
  withMapScopeRules,
} from '@shared/http/mapQueryCommon';
import { LIVE_JOB_POSTING_SQL } from '@modules/matching/domain/openJobStatuses';
import { PATIENT_STATUSES } from '../../domain/enums/PatientStatus';

export const MAX_PATIENT_MAP_POINTS = MAX_MAP_POINTS;

export const PatientsMapBodySchema = withMapScopeRules(
  z
    .object({
      ...mapScopeShape,
      /** Status de paciente. Ausente = todos (o filtro é da tela). */
      status: z.array(z.enum(PATIENT_STATUSES as unknown as [string, ...string[]])).optional(),
      /** true → só pacientes com ao menos uma vaga aberta. */
      with_open_vacancies: z.boolean().optional(),
      /**
       * Busca por nome — a TERCEIRA forma de escopo, ao lado de centro+raio e
       * província/localidade. Existe porque o seletor de âncora da tela era o
       * único caminho para o mapa e só enxergava 50 km do centro do país:
       * paciente de Mar del Plata (381 km) não aparecia, e a tela respondia
       * "Sin resultados" — que se lê como "não existe".
       *
       * Mínimo de 2 caracteres: 1 letra devolveria quase a base inteira, e aí
       * "escopo" não seria escopo nenhum.
       */
      search: z.string().trim().min(2).max(80).optional(),
    })
    .strict(),
  (q) => q.search !== undefined,
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
  open_vacancies: string | number | null;
  distance_km: string | number | null;
  /** `COUNT(*) OVER()`: o total do filtro INTEIRO, igual em toda linha. */
  total_count: number;
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
  if (q.with_open_vacancies === true) conds.push('ov.open_vacancies > 0');
  if (q.search) {
    // Nome COMPLETO nas duas ordens: o operador digita "Reyna Alaburda, Ana
    // Paula" como lê no WhatsApp, e a base guarda nome e sobrenome separados —
    // casar campo a campo erraria quem digita os dois. `ILIKE` sem `unaccent`
    // é o mesmo que a busca da lista de pacientes já usa
    // (`PatientQueryRepository`); mudar isso aqui só criaria duas buscas com
    // comportamentos diferentes na mesma tela.
    const pSearch = i++;
    params.push(q.search);
    conds.push(
      `(concat_ws(' ', p.first_name, p.last_name) ILIKE '%' || $${pSearch} || '%'
        OR concat_ws(' ', p.last_name, p.first_name) ILIKE '%' || $${pSearch} || '%')`,
    );
  }

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
      ov.open_vacancies,
      ${distanceSelect},
      COUNT(*) OVER()::int AS total_count
    FROM patients p
    LEFT JOIN patient_addresses pa ON pa.patient_id = p.id AND pa.archived_at IS NULL
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_vacancies
      FROM job_postings jp
      WHERE jp.patient_id = p.id AND ${LIVE_JOB_POSTING_SQL}
    ) ov ON true
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
    const body = parseMapBody(PatientsMapBodySchema, req, res);
    if (!body) return;

    try {
      const { sql, params } = buildPatientsMapQuery(body);
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

      // O total é o do BANCO, não o do array: o LIMIT corta a lista, nunca a contagem.
      respondMapPoints(req, res, 'patients.map.read', body, data, totalFromRows(result.rows));
    } catch (error: unknown) {
      respondMapError(res, error, 'AdminPatientsMapController:getMapPoints', 'Failed to load patients map');
    }
  }
}
