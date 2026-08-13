import type { Pool } from 'pg';
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import { resolveZoneKey, UNRESOLVED_ZONE_KEY } from '@shared/utils/zoneKey';
import { OPEN_JOB_STATUSES_SET } from '../domain/openJobStatuses';
import {
  zoneAnalyticsSchema,
  type ZoneAnalyticsData,
  type ZoneAnalyticsZone,
} from './zoneAnalyticsSchema';

/** Statuses de vaga considerados "demanda aberta" — SSOT em domain/openJobStatuses.
 *  Filtrado em JS (não SQL): "patients" precisa de TODAS as vagas do paciente,
 *  não só as abertas; "demand" é um FILTER sobre a mesma linha já buscada. */
const OPEN_JOB_STATUSES = OPEN_JOB_STATUSES_SET;

export interface ZoneAnalyticsFilters {
  /** workers.profession / job_postings.required_professions — ver Profession (@modules/worker/domain/enums/Profession): 'AT'|'CAREGIVER'|'NURSE'|'KINESIOLOGIST'|'PSYCHOLOGIST'. */
  profession?: string | null;
}

/** Linha em grão de job_posting (1 linha por vaga — nunca pré-agregada em SQL,
 *  pra deduplicar patient_id em JS via Set e não contar 2x paciente com N vagas
 *  na mesma zona). */
interface PatientDemandRow {
  patient_id: string | null;
  state: string | null;
  city: string | null;
  status: string;
}

/** Linha em grão de (worker, service_area) — LEFT JOIN: worker sem área
 *  nenhuma ainda aparece (1 linha, state/city null → "Não informado"), e
 *  worker com N áreas aparece N vezes (dedup por Set de w.id em JS). */
interface WorkerZoneRow {
  id: string;
  state: string | null;
  city: string | null;
  sex_bidx: Buffer | null;
  status: string;
}

const PATIENT_DEMAND_SQL = `
  SELECT
    jp.patient_id AS patient_id,
    pa.state      AS state,
    pa.city       AS city,
    jp.status     AS status
  FROM job_postings jp
  LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
  WHERE jp.deleted_at IS NULL
    AND jp.is_draft = false
    AND jp.is_test = false
    AND ($1::text IS NULL OR $1 = ANY(jp.required_professions))
`;

const WORKER_ZONE_SQL = `
  SELECT
    w.id       AS id,
    wsa.state  AS state,
    wsa.city   AS city,
    w.sex_bidx AS sex_bidx,
    w.status   AS status
  FROM workers w
  LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id
  WHERE w.merged_into_id IS NULL
    AND w.is_test = false
    AND ${excludeDisabledWorkersSql('w')}
    AND ($1::text IS NULL OR w.profession = $1)
`;

/** Acumulador mutável por zona — Sets de ID (não contadores) para que N linhas
 *  do mesmo paciente/worker na MESMA zona canônica contem 1 vez só. */
interface ZoneAccumulator {
  label: string;
  patients: Set<string>;
  workersMale: Set<string>;
  workersFemale: Set<string>;
  availability: Set<string>;
  demand: number;
}

/**
 * Agrega o bloco "Analytics por Zona" do Dashboard de Gestão à Vista (ClickUp
 * 86ajb4qnw): pacientes e demanda por zona (job_postings via patient_addresses,
 * FK patient_address_id — migration 149) + prestadores por zona×sexo e
 * disponibilidade (worker_service_areas + workers.sex_bidx — migration 218).
 *
 * READ-ONLY: 2 queries SQL diretas em grão de ID (convenção do módulo — ver
 * GetManagementDashboardUseCase / GetArmedCasesUseCase), agregadas em JS via
 * Set<id> por zona canônica (resolveZoneKey — @shared/utils/zoneKey). "Zona"
 * é a PROVÍNCIA canônica (decisão consciente: granularidade de bairro/cidade
 * é grossa e inconsistente em worker_service_areas — ver docstring de
 * zoneKey.ts) — deduplica paciente com N vagas ou worker com N áreas na
 * MESMA província, funde "CABA"/"Capital Federal", e cai em "Não informado"
 * quando a província não resolve ou é lixo (CPA postal).
 *
 * Sexo do prestador NUNCA é decriptado: comparação é via blind index (HMAC)
 * contra os buffers de normalizeSexValue('male')/normalizeSexValue('female')
 * ('MALE'/'FEMALE' canônico — mesmo SSOT do write-path em
 * WorkerImportRepository/WorkerPersonalInfoRepository e do filtro em
 * AdminWorkersListHelpers) gerados uma única vez.
 *
 * Zonas sem state/city resolvível (incluindo worker SEM nenhuma
 * worker_service_areas — LEFT JOIN, simétrico ao lado paciente) caem no
 * bucket "Não informado" — nunca somem silenciosamente.
 */
export class GetZoneAnalyticsUseCase {
  constructor(
    private readonly db: Pool,
    private readonly blindIndexService: BlindIndexService = new BlindIndexService(),
  ) {}

  async execute(filters: ZoneAnalyticsFilters = {}): Promise<ZoneAnalyticsData> {
    const profession = filters.profession ?? null;

    // SSOT: sex_bidx é gravado a partir de normalizeSexValue(...) (write-path em
    // WorkerImportRepository/WorkerPersonalInfoRepository, filtro em
    // AdminWorkersListHelpers) — 'MALE'/'FEMALE' maiúsculo, não 'male'/'female'
    // hardcoded. Derivar daqui garante que o HMAC bata mesmo se a normalização mudar.
    const [maleBidx, femaleBidx] = await Promise.all([
      this.blindIndexService.generateValueBidx(normalizeSexValue('male')),
      this.blindIndexService.generateValueBidx(normalizeSexValue('female')),
    ]);

    const [patientResult, workerResult] = await Promise.all([
      this.db.query<PatientDemandRow>(PATIENT_DEMAND_SQL, [profession]),
      this.db.query<WorkerZoneRow>(WORKER_ZONE_SQL, [profession]),
    ]);

    const zoneMap = new Map<string, ZoneAccumulator>();
    const getOrCreate = (key: string, label: string): ZoneAccumulator => {
      let acc = zoneMap.get(key);
      if (!acc) {
        acc = {
          label,
          patients: new Set(),
          workersMale: new Set(),
          workersFemale: new Set(),
          availability: new Set(),
          demand: 0,
        };
        zoneMap.set(key, acc);
      }
      return acc;
    };

    for (const row of patientResult.rows) {
      const { key, label } = resolveZoneKey(row.state, row.city);
      const acc = getOrCreate(key, label);
      if (row.patient_id) acc.patients.add(row.patient_id);
      if (OPEN_JOB_STATUSES.has(row.status)) acc.demand += 1;
    }

    for (const row of workerResult.rows) {
      const { key, label } = resolveZoneKey(row.state, row.city);
      const acc = getOrCreate(key, label);
      if (row.status === 'REGISTERED') acc.availability.add(row.id);
      if (buffersEqual(row.sex_bidx, maleBidx)) {
        acc.workersMale.add(row.id);
      } else if (buffersEqual(row.sex_bidx, femaleBidx)) {
        acc.workersFemale.add(row.id);
      }
      // sex_bidx nulo/desconhecido: conta em availability (não filtra por sexo)
      // mas não entra em workersMale nem workersFemale — contrato só tem 2 buckets.
    }

    const naoInformado = zoneMap.get(UNRESOLVED_ZONE_KEY);
    const unresolvedCount = naoInformado
      ? naoInformado.patients.size + naoInformado.workersMale.size + naoInformado.workersFemale.size
      : 0;

    const zones: ZoneAnalyticsZone[] = Array.from(zoneMap.values())
      .map((acc) => ({
        zone: acc.label,
        patients: acc.patients.size,
        workersMale: acc.workersMale.size,
        workersFemale: acc.workersFemale.size,
        demand: acc.demand,
        availability: acc.availability.size,
      }))
      .sort((a, b) => b.demand - a.demand);

    return zoneAnalyticsSchema.parse({ zones, unresolvedCount });
  }
}

function buffersEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (!a || !b) return false;
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}
