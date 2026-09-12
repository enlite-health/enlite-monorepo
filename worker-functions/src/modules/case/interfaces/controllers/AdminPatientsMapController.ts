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
import { NOME_REDIGIDO, cellsOfRequest } from '@modules/identity/permissions';
import { canReadPatientContainer } from '../../application/patientContainerAccess';
import { escapeIlikeWildcards, hasSearchableContent } from '@shared/utils/ilikeEscape';
import { foldAccents, sqlFoldAccents } from '@shared/utils/accentFold';

export const MAX_PATIENT_MAP_POINTS = MAX_MAP_POINTS;

/**
 * Teto do escopo por NOME — menor que o geográfico, de propósito.
 *
 * O consumidor desta resposta é um seletor em que o operador escolhe UMA
 * pessoa. Devolver 500 domicílios com nome e coordenada para escolher um é
 * excesso no sentido literal do art. 4 inc. 1 da Ley 25.326 ("no excesivos en
 * relación al ámbito y finalidad") — parecer do `lex` de 07/09/2026, C-A. O
 * teto de 500 foi calibrado em 30/08 contra o CSV de export, para escopo
 * GEOGRÁFICO; nunca foi recalibrado para este.
 *
 * A tela não perde a informação: `total` continua vindo do `COUNT(*) OVER()`,
 * então ela diz "há mais — refiná o nome" em vez de mentir que são 50.
 */
export const MAX_NAME_SCOPE_POINTS = 50;

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
      search: z
        .string()
        .trim()
        /**
         * TRÊS caracteres, não dois — e o número é medido, não escolhido.
         *
         * Com 2, o curinga sintático estava fechado mas o SEMÂNTICO não:
         * termos legítimos varriam a base. Medido contra o Postgres de
         * produção em 07/09/2026 (só contagem):
         *   'an' → 266 linhas (38% da base) · 'ar' → 241 (35%) · 'el' → 209 (30%)
         * Com 3, o pior caso cai para 'mar' → 110 (16%), e o teto de
         * `MAX_NAME_SCOPE_POINTS` corta o resto. Condição C-B do `lex`.
         */
        .min(3)
        .max(80)
        /**
         * 🔒 Primeira das DUAS camadas contra o curinga (achado do gate no PR
         * #320). `%` casa qualquer coisa e `_` casa um caractere: como `search`
         * sozinho JÁ satisfaz a exigência de escopo, um corpo
         * `{country:'AR', search:'%%'}` passaria os 2 caracteres do mínimo e
         * devolveria a base inteira — nome, bairro e COORDENADA DE DOMICÍLIO —
         * com o log registrando um inocente "houve busca". Um termo feito só de
         * curinga não é uma busca; é 400. A segunda camada é o escape do valor
         * em `buildPatientsMapQuery`.
         */
        .refine(hasSearchableContent, { message: 'search must contain more than wildcards' })
        .optional(),
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
    // casar campo a campo erraria quem digita os dois.
    const pSearch = i++;
    // 🔒 Duas travas que só funcionam juntas:
    //  1. ESCAPE — o valor vai escapado e as cláusulas fecham com `ESCAPE '\\'`;
    //     sem a cláusula, a barra do escape é caractere comum e o curinga volta.
    //  2. ACENTO — termo e coluna passam pela MESMA tabela de dobra
    //     (`accentFold`), senão "Pena" nunca acha "Peña". Dobrar só um lado é
    //     pior que não dobrar: falha apenas nos nomes acentuados, que é o modo
    //     de falha que ninguém percebe.
    params.push(escapeIlikeWildcards(foldAccents(q.search)));
    const nomeDireto = sqlFoldAccents("concat_ws(' ', p.first_name, p.last_name)");
    const nomeInvertido = sqlFoldAccents("concat_ws(' ', p.last_name, p.first_name)");
    conds.push(
      `(${nomeDireto} ILIKE '%' || $${pSearch} || '%' ESCAPE '\\'
        OR ${nomeInvertido} ILIKE '%' || $${pSearch} || '%' ESCAPE '\\')`,
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
  // Escopo por nome tem teto próprio (lex C-A): é um seletor de UMA pessoa,
  // não uma varredura. `Math.min` para que um `limit` menor no corpo continue
  // valendo — o teto é máximo, nunca piso.
  params.push(q.search ? Math.min(q.limit, MAX_NAME_SCOPE_POINTS) : q.limit);

  const sql = `
    SELECT p.id, p.first_name, p.last_name, p.status,
      pa.id AS address_id, pa.lat, pa.lng, pa.city, pa.neighborhood, pa.state,
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

    // A busca por NOME é leitura de identidade: filtrar pelo nome em claro e devolver o pino
    // (coordenada do domicílio) com `NOME_REDIGIDO` seria um oráculo — "existe alguém chamado X, e
    // mora aqui". Achado do gate do sync main→stage (08/09/2026): a redação (stage, D286 fase 2) e a
    // busca (main, 07/09) nunca tinham se encontrado. Sem `patient_identity:read`, `search` é 403
    // nomeando o campo (molde do `hourlyValue` no serviço contratado), nunca ignorado em silêncio.
    const identidade = canReadPatientContainer(cellsOfRequest(req), 'identity');
    if (body.search && !identidade) {
      res.status(403).json({ success: false, error: 'Forbidden', details: { field: 'search' } });
      return;
    }

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
          // D286 fase 2: o nome do pino é IDENTIDADE do paciente (`patient_identity:read`); a rota é
          // endereço. Sem a célula, `NOME_REDIGIDO` (texto claro no banco — a prova é a fronteira).
          name: identidade ? [row.first_name, row.last_name].filter(Boolean).join(' ') || '—' : NOME_REDIGIDO,
          lat: hasCoords ? lat : null,
          lng: hasCoords ? lng : null,
          status: row.status,
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
