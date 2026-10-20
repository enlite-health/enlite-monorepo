/**
 * PatientContractedServiceRepository — o serviço contratado como entidade (migration 319,
 * spec 013, bloco C).
 *
 * Sem rota DELETE (lex C-a.4): baixa é `PATCH { active: false }`, que grava `ended_at`.
 * `country`/`createdBy`/`updatedBy` seguem o molde de `PatientDeviceTypeRepository`/`patient_addresses`
 * (316): `country` nasce do trigger quando o chamador não informa; autoria é uid, nunca valor
 * (lex C-a.3).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { operationDateOf } from '@shared/locale/operationDate';
import { ContractedServiceContractLinkWriter } from './contractedServiceContractLinkWriter';
import { DeviceTypeUnknownError } from './PatientDeviceTypeRepository';
import { fetchLiveVacancies, liveVacancySql, type LiveVacancy } from './liveVacancyOfService';
import {
  captureFieldBefore,
  isClearedValue,
  recordFieldChange,
  type GuardedServiceField,
} from './vacancySourceChangeNotice';
import {
  ContractedServiceProviderRepository,
  type ContractedServiceProviderDetail,
} from './ContractedServiceProviderRepository';
import { computeScheduleWeeklyHours } from '../../matching/domain/scheduleHours';
import { replaceServiceSlots } from './ServiceSlotWriter';
import { PatientStatusDerivation, type PatientStatusDerivationPort } from '../application/PatientStatusDerivation';
import { fetchCurrentAuthorizations, type CurrentAuthorization } from './contractedServiceAuthorizationRead';
import { fetchServiceSchedules } from './ContractedServiceDetailMapper';
import {
  batchEntry,
  derivePayerCoverageMatch,
  payerAtMany,
  payerHistoryMany,
  type PayerCoverageMatch,
  type PayerHistoryItemRead,
  type PayerRead,
} from './contractedServicePayerRead';
import { priceStateMany, type PriceState, type TaxState } from './contractedServicePriceRead';
import { readCoverageEntries } from './patientCoverageRead';

/**
 * Turno do horário na ESCRITA (spec 056): início + duração; o fim nunca é gravado. `dayOfWeek`: 0 = domingo.
 */
export interface ContractedServiceScheduleSlot {
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
}

/** Turno do horário na LEITURA: `horario_do_servico(id, asOf)` — o `endTime` é derivado (início + duração). */
export interface ContractedServiceScheduleView extends ContractedServiceScheduleSlot {
  endTime: string;
}

/**
 * `address_id` apontou para um endereço que NÃO é do paciente (FK composta
 * `pcs_address_same_patient_fk`, migration 330) — o banco recusa; o controller responde 422.
 */
export class AddressNotOfPatientError extends Error {
  readonly code = 'ADDRESS_NOT_OF_PATIENT';
  constructor(readonly addressId: string | null | undefined) {
    super('address_id does not belong to this patient');
    this.name = 'AddressNotOfPatientError';
  }
}

/**
 * F2/F5 (vaga-le-do-servico-contratado): o horário e a quantidade do serviço são a ÚNICA fonte desses campos na vaga viva —
 * apagá-los (`null`/`[]`; quantidade `null`/`0`) com vaga viva deixaria a vaga sem eles. O controller responde 422.
 */
export class ServiceFieldRequiredByLiveVacancyError extends Error {
  readonly code = 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY';
  constructor(readonly field: GuardedServiceField, readonly vacancyIds: string[]) {
    super(`service ${field} cannot be cleared while a live vacancy reads it`);
    this.name = 'ServiceFieldRequiredByLiveVacancyError';
  }
}

const ADDRESS_FK = 'pcs_address_same_patient_fk';

function isAddressFkViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23503' && e?.constraint === ADDRESS_FK;
}

export interface ContractedServiceDetail {
  id: string;
  patientId: string;
  serviceCode: string;
  professionalProfile: string | null;
  providersNeeded: number | null;
  /** Autorização corrente e vigente hoje (spec 056, dono: `contracted_service_authorization`) — null = nenhuma. */
  authorization: CurrentAuthorization | null;
  /** `pcs.authorized_hours` (coluna legada, só exibição; não é mais escrita pela API — spec 056 §8). */
  legacyAuthorizedHours: number | null;
  /** Σ das faixas vigentes hoje (`computeScheduleWeeklyHours(schedule)`) — o horário é das faixas, não de coluna (spec 056). */
  scheduleHours: number;
  careLocation: string | null;
  startDate: string | null;
  supervisionFrequency: string | null;
  guardShift: string | null;
  /** Franja etária solicitada do prestador (spec 015, migration 322) — null = não informado. */
  providerAgeBand: string | null;
  /** Endereço do paciente onde o serviço é prestado (migration 330) — null = ainda não vinculado. */
  addressId: string | null;
  /** Horário do encuadre, formato do editor (migration 330) — null = ainda sem horário. */
  schedule: ContractedServiceScheduleView[] | null;
  /**
   * Spec 027 Fase 3 (D507/D508): o que a vaga precisa. Os 5 primeiros são COPIADOS para a vaga na ativação;
   * `workerAttributes` e `dailyObs` são SÓ FICHA (nunca copiados). Texto livre: nunca em log (lex T.4).
   */
  requiredProfessions: string[] | null;
  /** 'M' | 'F' | 'BOTH' (Zod). Sem campo de motivo: o motivo é clínico e nunca se registra (D507 item 4). */
  requiredSex: string | null;
  requiredExperience: string | null;
  workerAttributes: string | null;
  workSchedule: string | null;
  /** Dia em que a Enlite paga o PRESTADOR (D508 b), não o termo de pagamento da família. */
  paymentDay: string | null;
  dailyObs: string | null;
  /** Vaga viva deste serviço (spec 018 PR-6; objeto na spec 047) — null = sem vaga OU redigida (ver `liveVacancyRedacted`, aplicado na projeção por ator). */
  liveVacancy: LiveVacancy | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  deviceTypes: string[];
  providers: ContractedServiceProviderDetail[];
  /**
   * Spec 058 (§G/§P/§D): pagador, preço, imposto e divergência pagador × cobertura NA DATA `asOf` (dia de operação do país do serviço,
   * de `operationDateOf(country, requestNow)`). Vêm CRUS daqui — a redação por ator (preço, nomes, `coverageMatch`) é de
   * `projectContractedServiceForActor`. A ficha e a rota montam estes campos pelas MESMAS funções em lote.
   */
  asOf: string;
  payer: PayerRead;
  payerHistory: PayerHistoryItemRead[];
  price: PriceState;
  tax: TaxState;
  coverageMatch: PayerCoverageMatch;
  createdAt: string;
  updatedAt: string;
}

export interface ContractedServiceWriteInput {
  serviceCode?: string;
  professionalProfile?: string | null;
  providersNeeded?: number | null;
  careLocation?: string | null;
  startDate?: string | null;
  supervisionFrequency?: string | null;
  guardShift?: string | null;
  providerAgeBand?: string | null;
  addressId?: string | null;
  schedule?: ContractedServiceScheduleSlot[] | null;
  requiredProfessions?: string[] | null;
  requiredSex?: string | null;
  requiredExperience?: string | null;
  workerAttributes?: string | null;
  workSchedule?: string | null;
  paymentDay?: string | null;
  dailyObs?: string | null;
  deviceTypeCodes?: string[];
  /** Só `false` é caminho válido de escrita (baixa) — reabrir não existe (mesma régua do C-e.2). */
  active?: boolean;
  country?: 'AR' | 'BR' | null;
  actorUid: string;
}

export interface CreateContractedServiceInput extends ContractedServiceWriteInput {
  patientId: string;
  serviceCode: string;
}

/** Campo vigiado de `GUARDED_SERVICE_COLUMNS` → chave do corpo do PATCH. */
const GUARDED_FIELDS: ReadonlyArray<
  readonly [
    GuardedServiceField,
    'schedule' | 'providersNeeded' | 'providerAgeBand' | 'requiredSex' | 'requiredProfessions' | 'requiredExperience' | 'workSchedule' | 'paymentDay',
  ]
> = [
  ['schedule', 'schedule'],
  ['providers_needed', 'providersNeeded'],
  ['age_range', 'providerAgeBand'],
  // 057/D523: os 5 de recrutamento que a vaga lê do serviço.
  ['required_sex', 'requiredSex'],
  ['required_professions', 'requiredProfessions'],
  ['required_experience', 'requiredExperience'],
  ['work_schedule', 'workSchedule'],
  ['payment_day', 'paymentDay'],
];

const WRITABLE_COLUMNS: Array<[keyof ContractedServiceWriteInput, string]> = [
  ['serviceCode', 'service_code'],
  ['professionalProfile', 'professional_profile'],
  ['providersNeeded', 'providers_needed'],
  ['careLocation', 'care_location'],
  ['startDate', 'start_date'],
  ['supervisionFrequency', 'supervision_frequency'],
  ['guardShift', 'guard_shift'],
  ['providerAgeBand', 'provider_age_band'],
  ['addressId', 'address_id'],
  ['requiredProfessions', 'required_professions'],
  ['requiredSex', 'required_sex'],
  ['requiredExperience', 'required_experience'],
  ['workerAttributes', 'worker_attributes'],
  ['workSchedule', 'work_schedule'],
  ['paymentDay', 'payment_day'],
  ['dailyObs', 'daily_obs'],
];

interface ServiceRow {
  id: string;
  patient_id: string;
  service_code: string;
  professional_profile: string | null;
  providers_needed: number | null;
  authorized_hours: string | null;
  care_location: string | null;
  start_date: string | null;
  supervision_frequency: string | null;
  guard_shift: string | null;
  provider_age_band: string | null;
  address_id: string | null;
  required_professions: string[] | null;
  required_sex: string | null;
  required_experience: string | null;
  worker_attributes: string | null;
  work_schedule: string | null;
  payment_day: string | null;
  daily_obs: string | null;
  active: boolean;
  ended_at: string | null;
  country: string;
  created_at: string;
  updated_at: string;
}

/** Sentinela interna: desfaz a transação do `update` quando o serviço não existe (nunca sai do repositório). */
const SERVICE_ROW_MISSING = Symbol('patient_contracted_services: linha inexistente');

export class PatientContractedServiceRepository {
  private poolMemo?: Pool;

  constructor(
    private readonly providerRepo: ContractedServiceProviderRepository = new ContractedServiceProviderRepository(),
    /** Injeção só para o unitário; os call sites de produção não mudam — o default é o escritor real das faixas. */
    private readonly replaceSlots: typeof replaceServiceSlots = replaceServiceSlots,
    /** ⚑13 (spec 056): editar o horário muda o denominador da régua → recalcula o estado na MESMA transação. */
    private readonly derivation: PatientStatusDerivationPort = new PatientStatusDerivation(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * `asOf` = dia de operação do país do serviço no `requestNow` da requisição. Pagador/preço/imposto/divergência saem das MESMAS funções
   * em lote que a ficha (`mapContractedServices`), aqui com `[row.id]` — nenhuma query própria de pagador (D-44).
   */
  private async decorate(row: ServiceRow, cli: Pool | PoolClient, requestNow: Date): Promise<ContractedServiceDetail> {
    const asOf = operationDateOf(row.country, requestNow);
    const devices = await cli.query<{ device_type: string }>(
      `SELECT csd.device_type
         FROM contracted_service_devices csd
         JOIN device_types d ON d.code = csd.device_type
        WHERE csd.service_id = $1
        ORDER BY d.sort_order, d.code`,
      [row.id],
    );
    const providers = await this.providerRepo.listForService(row.id);
    // Spec 018 PR-6 / spec 047 F2: a MESMA leitura do mapper da ficha (`fetchLiveVacancies`) — um dono só.
    const liveVacancy = (await fetchLiveVacancies(cli, [row.id])).get(row.id) ?? null;
    // Spec 058 (B1): agenda e autorização no dia de operação do serviço — as MESMAS funções da ficha (`ContractedServiceDetailMapper`).
    const schedule = (await fetchServiceSchedules(cli, [row.id], asOf)).get(row.id) ?? null;
    const authorization = (await fetchCurrentAuthorizations(cli, [row.id], asOf)).get(row.id) ?? null;
    const [payers, histories, prices, coverageEntries] = await Promise.all([
      payerAtMany(cli, [row.id], asOf),
      payerHistoryMany(cli, [row.id]),
      priceStateMany(cli, [row.id], asOf),
      readCoverageEntries(cli, row.patient_id),
    ]);
    const payer = batchEntry(payers, row.id);
    const priceTax = batchEntry(prices, row.id);
    return {
      id: row.id,
      liveVacancy,
      patientId: row.patient_id,
      serviceCode: row.service_code,
      professionalProfile: row.professional_profile,
      providersNeeded: row.providers_needed,
      authorization,
      legacyAuthorizedHours: row.authorized_hours != null ? Number(row.authorized_hours) : null,
      scheduleHours: computeScheduleWeeklyHours(schedule),
      careLocation: row.care_location,
      startDate: row.start_date,
      supervisionFrequency: row.supervision_frequency,
      guardShift: row.guard_shift,
      providerAgeBand: row.provider_age_band,
      addressId: row.address_id,
      schedule,
      requiredProfessions: row.required_professions,
      requiredSex: row.required_sex,
      requiredExperience: row.required_experience,
      workerAttributes: row.worker_attributes,
      workSchedule: row.work_schedule,
      paymentDay: row.payment_day,
      dailyObs: row.daily_obs,
      active: row.active,
      endedAt: row.ended_at,
      country: row.country,
      deviceTypes: devices.rows.map((d) => d.device_type),
      providers,
      asOf,
      payer,
      payerHistory: batchEntry(histories, row.id),
      price: priceTax.price,
      tax: priceTax.tax,
      coverageMatch: derivePayerCoverageMatch(payer, coverageEntries),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Todos os serviços (ativos e inativos) de um paciente, mais recente primeiro. */
  async listForPatient(patientId: string, requestNow: Date): Promise<ContractedServiceDetail[]> {
    const { rows } = await this.pool.query<ServiceRow>(
      `SELECT * FROM patient_contracted_services WHERE patient_id = $1 ORDER BY active DESC, created_at ASC`,
      [patientId],
    );
    return Promise.all(rows.map((r) => this.decorate(r, this.pool, requestNow)));
  }

  async findById(serviceId: string, requestNow: Date): Promise<ContractedServiceDetail | null> {
    const { rows } = await this.pool.query<ServiceRow>(
      `SELECT * FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
    if (rows.length === 0) return null;
    return this.decorate(rows[0], this.pool, requestNow);
  }

  private async validateDeviceCodes(codes: readonly string[], cli: PoolClient): Promise<void> {
    if (codes.length === 0) return;
    const wanted = Array.from(new Set(codes));
    const catalog = await cli.query<{ code: string }>('SELECT code FROM device_types WHERE active');
    const active = new Set(catalog.rows.map((r) => r.code));
    const unknown = wanted.filter((c) => !active.has(c));
    if (unknown.length > 0) throw new DeviceTypeUnknownError(unknown);
  }

  private async replaceDevices(serviceId: string, codes: readonly string[], cli: PoolClient): Promise<void> {
    await this.validateDeviceCodes(codes, cli);
    await cli.query('DELETE FROM contracted_service_devices WHERE service_id = $1', [serviceId]);
    for (const code of Array.from(new Set(codes))) {
      await cli.query(
        'INSERT INTO contracted_service_devices (service_id, device_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [serviceId, code],
      );
    }
  }

  /**
   * Cria um serviço contratado. `country`/autoria gravados na MESMA transação (lex C-a.1/C-a.3).
   *
   * `withActorContext` (D95), não `pool.connect()` cru: o client cru chega SEM `app.user_country`
   * e a policy de país da 411 recusa com `rls_session_without_identity` — foi o 500 medido na
   * stage em 07/09. O helper reusa o client fixado da request (que já carrega o país) ou aplica
   * `SET LOCAL` na transação; o `ROLLBACK` também é dele.
   */
  async create(input: CreateContractedServiceInput, requestNow: Date): Promise<ContractedServiceDetail> {
    try {
      const row = await withActorContext(this.pool, async (cli) => {
        const cols = ['patient_id', 'service_code', 'created_by', 'updated_by'];
        const values: unknown[] = [input.patientId, input.serviceCode, input.actorUid, input.actorUid];
        if (input.country) {
          cols.push('country');
          values.push(input.country);
        }
        for (const [key, col] of WRITABLE_COLUMNS) {
          if (key === 'serviceCode') continue;
          const value = input[key];
          if (value !== undefined) {
            cols.push(col);
            values.push(value);
          }
        }
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const ins = await cli.query<{ id: string }>(
          `INSERT INTO patient_contracted_services (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
          values,
        );
        const serviceId = ins.rows[0].id;
        if (input.deviceTypeCodes && input.deviceTypeCodes.length > 0) {
          await this.replaceDevices(serviceId, input.deviceTypeCodes, cli);
        }
        // Spec 056: as faixas são o dono do horário — gravadas na MESMA transação, só quando o corpo manda
        // `schedule` (chave ausente = nada a fazer). Falhar aqui desfaz o INSERT acima (nada de faixa sem
        // serviço nem serviço com faixa velha).
        if (input.schedule !== undefined) {
          await this.replaceSlots(cli, serviceId, input.schedule ?? null, input.actorUid);
        }
        const sel = await cli.query<ServiceRow>('SELECT * FROM patient_contracted_services WHERE id = $1', [serviceId]);
        return sel.rows[0];
      });
      return this.decorate(row, this.pool, requestNow);
    } catch (err) {
      if (isAddressFkViolation(err)) throw new AddressNotOfPatientError(input.addressId);
      throw err;
    }
  }

  /**
   * Baja/reativação da vaga ligada ao serviço (change baja-vacante-por-servico): some do
   * WordPress/prestador, mas a página pública segue servindo "desativada". Mesmo `cli` do
   * `update` chamador — falha aqui desfaz o UPDATE do serviço junto. `false` → grava
   * `status_before_baja` e vira `DE_BAJA` (vagas vivas, ainda não `DE_BAJA` — idempotente).
   * `true` → restaura `COALESCE(status_before_baja, 'SEARCHING')` (só vagas em `DE_BAJA`).
   * `undefined` → no-op. Vaga órfã (sem `contracted_service_id`) fica fora pelo WHERE.
   */
  private async applyVacancyBajaGatilho(cli: PoolClient, serviceId: string, active: boolean | undefined): Promise<void> {
    if (active === false) {
      await cli.query(
        `UPDATE job_postings SET status_before_baja = status, status = 'DE_BAJA'
          WHERE contracted_service_id = $1 AND deleted_at IS NULL AND status != 'DE_BAJA'`,
        [serviceId],
      );
    } else if (active === true) {
      await cli.query(
        `UPDATE job_postings SET status = COALESCE(status_before_baja, 'SEARCHING'), status_before_baja = NULL
          WHERE contracted_service_id = $1 AND deleted_at IS NULL AND status = 'DE_BAJA'`,
        [serviceId],
      );
    }
  }

  /**
   * F2/F5: recusa APAGAR um campo vigiado do serviço (`GUARDED_SERVICE_COLUMNS`) enquanto há vaga viva ("viva" = não apagada,
   * `deleted_at IS NULL`, qualquer status — vaga CLOSED/DE_BAJA ainda ocupa o serviço; spec 056 ⚑E). Trava o serviço e depois as vagas (`FOR UPDATE`) na MESMA transação,
   * na ordem da ativação (serviço → vagas): ativar×apagar não deixa vaga viva sem horário — quem chega
   * depois enxerga o commit do outro. Client = `withActorContext` (com identidade), nunca `connect()` cru.
   */
  private async refuseClearWhenLiveVacancy(cli: PoolClient, serviceId: string, field: GuardedServiceField): Promise<void> {
    await cli.query('SELECT id FROM patient_contracted_services WHERE id = $1 FOR UPDATE', [serviceId]);
    const live = await cli.query<{ id: string }>(
      `SELECT id FROM job_postings
        WHERE contracted_service_id = $1 AND ${liveVacancySql('')}
        FOR UPDATE`,
      [serviceId],
    );
    if ((live.rowCount ?? live.rows.length) > 0) {
      throw new ServiceFieldRequiredByLiveVacancyError(field, live.rows.map((r) => r.id));
    }
  }

  /** Mesma chave das triggers T1/T2/T3 e do `ContractedServiceContractLinkWriter`; antes de qualquer escrita da baixa (ordem: lock → UPDATE). */
  private async lockPatientOfService(cli: PoolClient, serviceId: string): Promise<void> {
    await cli.query(
      `SELECT pg_advisory_xact_lock(hashtext('contract-link:patient:' || patient_id::text)) FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
  }

  /**
   * Atualização PARCIAL (Merge Patch, molde `PatientClinicalRepository`): chave ausente não
   * toca a coluna. `active:false` grava `ended_at=NOW()` (baixa, C-a.4); o schema HTTP só
   * aceita `false` (reabrir não existe, lex C-a.4) — o repositório aceita as duas direções
   * porque `applyVacancyBajaGatilho` acima precisa da simetria.
   */
  async update(serviceId: string, patch: ContractedServiceWriteInput, requestNow: Date): Promise<ContractedServiceDetail | null> {
    try {
      // Mesmo molde do `create`: transação COM contexto de país (D95), nunca client cru.
      const row = await withActorContext(this.pool, async (cli) => {
        // F3/F5: o valor de ANTES é lido (e travado) na mesma transação do UPDATE; `undefined` quando o PATCH não toca o campo.
        // Baixa: o lock do paciente vem ANTES de qualquer lock de linha (o FOR UPDATE do `captureFieldBefore`) — a mesma ordem do escritor do vínculo.
        if (patch.active === false) await this.lockPatientOfService(cli, serviceId);
        const before = new Map<GuardedServiceField, unknown>();
        for (const [field, key] of GUARDED_FIELDS) before.set(field, await captureFieldBefore(cli, serviceId, field, patch[key]));
        // F2/F5: apagar um campo que a vaga viva lê → recusa (um campo por vez, na ordem de GUARDED_FIELDS).
        // 057 gate A1: só recusa se o PATCH realmente LIMPA (antes preenchido); reenviar `null` num campo já vazio não é apagar.
        for (const [field, key] of GUARDED_FIELDS) {
          if (isClearedValue(field, patch[key]) && !isClearedValue(field, before.get(field))) {
            await this.refuseClearWhenLiveVacancy(cli, serviceId, field);
          }
        }
        const sets: string[] = [];
        const params: unknown[] = [serviceId];
        const push = (col: string, value: unknown): void => {
          params.push(value);
          sets.push(`${col} = $${params.length}`);
        };
        for (const [key, col] of WRITABLE_COLUMNS) {
          const value = patch[key];
          if (value !== undefined) push(col, value);
        }
        if (patch.active !== undefined) {
          push('active', patch.active);
          sets.push(patch.active ? 'ended_at = NULL' : 'ended_at = NOW()');
        }
        if (patch.deviceTypeCodes !== undefined) {
          await this.replaceDevices(serviceId, patch.deviceTypeCodes, cli);
        }
        // `schedule` não é coluna: PATCH só com horário ainda carimba autoria/`updated_at` (e detecta serviço inexistente).
        if (sets.length > 0 || patch.schedule !== undefined) {
          params.push(patch.actorUid);
          sets.push(`updated_by = $${params.length}`);
          sets.push('updated_at = NOW()');
          const res = await cli.query(`UPDATE patient_contracted_services SET ${sets.join(', ')} WHERE id = $1`, params);
          // Linha inexistente → ROLLBACK (o `replaceDevices` acima pode já ter escrito) e null.
          if ((res.rowCount ?? 0) === 0) throw SERVICE_ROW_MISSING;
        }
        // F3/F5: valor mudou + vaga publicada viva → aviso (mesma transação; falha aqui desfaz o UPDATE).
        for (const [field, key] of GUARDED_FIELDS) await recordFieldChange(cli, serviceId, field, before.get(field), patch[key]);
        await this.applyVacancyBajaGatilho(cli, serviceId, patch.active);
        // Spec 056: mesma régua do `create` — só quando o corpo manda `schedule` (Merge Patch: chave ausente não toca).
        if (patch.schedule !== undefined) {
          await this.replaceSlots(cli, serviceId, patch.schedule ?? null, patch.actorUid);
        }
        const sel = await cli.query<ServiceRow>('SELECT * FROM patient_contracted_services WHERE id = $1', [serviceId]);
        const updated = sel.rows[0] ?? null;
        // Passo 7 (P§6): derivação no fim da transação. Erro (≠ NotReady, absorvido pela própria classe) desfaz tudo.
        if (patch.schedule !== undefined && updated !== null) {
          await this.derivation.run(cli, updated.patient_id, new Date());
        }
        // Baixa: o vínculo vivo com a obra social acaba junto (senão o serviço novo do paciente bate em TWO_PAYERS_OVERLAP).
        if (patch.active === false && updated !== null) {
          await new ContractedServiceContractLinkWriter().endOnServiceClose(cli, serviceId, operationDateOf(updated.country, requestNow), patch.actorUid);
        }
        return updated;
      });
      if (row === null) return null;
      return this.decorate(row, this.pool, requestNow);
    } catch (err) {
      if (err === SERVICE_ROW_MISSING) return null;
      if (isAddressFkViolation(err)) throw new AddressNotOfPatientError(patch.addressId);
      throw err;
    }
  }
}
