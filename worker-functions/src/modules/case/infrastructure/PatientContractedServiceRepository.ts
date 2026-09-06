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
import { DeviceTypeUnknownError } from './PatientDeviceTypeRepository';
import {
  ContractedServiceProviderRepository,
  type ContractedServiceProviderDetail,
} from './ContractedServiceProviderRepository';

/**
 * Slot de horário do encuadre — o MESMO formato que `scheduleToJsonb` persiste em
 * `job_postings.schedule` (array; `normalizeSchedule` já lê). `dayOfWeek`: 0 = domingo.
 */
export interface ContractedServiceScheduleSlot {
  dayOfWeek: number;
  startTime: string;
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
  authorizedHours: number | null;
  weeklyHours: number | null;
  careLocation: string | null;
  /** Preço do contrato (lex C-c) — a REDAÇÃO por papel acontece no controller, nunca aqui. */
  hourlyValue: number | null;
  version: string | null;
  startDate: string | null;
  contractType: string | null;
  taxCondition: string | null;
  supervisionFrequency: string | null;
  guardShift: string | null;
  /** Franja etária solicitada do prestador (spec 015, migration 322) — null = não informado. */
  providerAgeBand: string | null;
  /** Endereço do paciente onde o serviço é prestado (migration 330) — null = ainda não vinculado. */
  addressId: string | null;
  /** Horário do encuadre, formato do editor (migration 330) — null = ainda sem horário. */
  schedule: ContractedServiceScheduleSlot[] | null;
  active: boolean;
  endedAt: string | null;
  country: string;
  deviceTypes: string[];
  providers: ContractedServiceProviderDetail[];
  createdAt: string;
  updatedAt: string;
}

export interface ContractedServiceWriteInput {
  serviceCode?: string;
  professionalProfile?: string | null;
  providersNeeded?: number | null;
  authorizedHours?: number | null;
  weeklyHours?: number | null;
  careLocation?: string | null;
  hourlyValue?: number | null;
  version?: string | null;
  startDate?: string | null;
  contractType?: string | null;
  taxCondition?: string | null;
  supervisionFrequency?: string | null;
  guardShift?: string | null;
  providerAgeBand?: string | null;
  addressId?: string | null;
  schedule?: ContractedServiceScheduleSlot[] | null;
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

const WRITABLE_COLUMNS: Array<[keyof ContractedServiceWriteInput, string]> = [
  ['serviceCode', 'service_code'],
  ['professionalProfile', 'professional_profile'],
  ['providersNeeded', 'providers_needed'],
  ['authorizedHours', 'authorized_hours'],
  ['weeklyHours', 'weekly_hours'],
  ['careLocation', 'care_location'],
  ['hourlyValue', 'hourly_value'],
  ['version', 'version'],
  ['startDate', 'start_date'],
  ['contractType', 'contract_type'],
  ['taxCondition', 'tax_condition'],
  ['supervisionFrequency', 'supervision_frequency'],
  ['guardShift', 'guard_shift'],
  ['providerAgeBand', 'provider_age_band'],
  ['addressId', 'address_id'],
  ['schedule', 'schedule'],
];

/**
 * `schedule` é JSONB e chega como ARRAY JS: o driver `pg` serializa objeto como JSON, mas array
 * JS vira ARRAY Postgres (`{...}`), que o JSONB recusa. Só esta coluna precisa do stringify.
 */
function toColumnValue(key: keyof ContractedServiceWriteInput, value: unknown): unknown {
  if (key === 'schedule' && value != null) return JSON.stringify(value);
  return value;
}

interface ServiceRow {
  id: string;
  patient_id: string;
  service_code: string;
  professional_profile: string | null;
  providers_needed: number | null;
  authorized_hours: string | null;
  weekly_hours: string | null;
  care_location: string | null;
  hourly_value: string | null;
  version: string | null;
  start_date: string | null;
  contract_type: string | null;
  tax_condition: string | null;
  supervision_frequency: string | null;
  guard_shift: string | null;
  provider_age_band: string | null;
  address_id: string | null;
  schedule: ContractedServiceScheduleSlot[] | null;
  active: boolean;
  ended_at: string | null;
  country: string;
  created_at: string;
  updated_at: string;
}

export class PatientContractedServiceRepository {
  private poolMemo?: Pool;

  constructor(
    private readonly providerRepo: ContractedServiceProviderRepository = new ContractedServiceProviderRepository(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  private async decorate(row: ServiceRow, cli: Pool | PoolClient): Promise<ContractedServiceDetail> {
    const devices = await cli.query<{ device_type: string }>(
      `SELECT csd.device_type
         FROM contracted_service_devices csd
         JOIN device_types d ON d.code = csd.device_type
        WHERE csd.service_id = $1
        ORDER BY d.sort_order, d.code`,
      [row.id],
    );
    const providers = await this.providerRepo.listForService(row.id);
    return {
      id: row.id,
      patientId: row.patient_id,
      serviceCode: row.service_code,
      professionalProfile: row.professional_profile,
      providersNeeded: row.providers_needed,
      authorizedHours: row.authorized_hours != null ? Number(row.authorized_hours) : null,
      weeklyHours: row.weekly_hours != null ? Number(row.weekly_hours) : null,
      careLocation: row.care_location,
      hourlyValue: row.hourly_value != null ? Number(row.hourly_value) : null,
      version: row.version,
      startDate: row.start_date,
      contractType: row.contract_type,
      taxCondition: row.tax_condition,
      supervisionFrequency: row.supervision_frequency,
      guardShift: row.guard_shift,
      providerAgeBand: row.provider_age_band,
      addressId: row.address_id,
      schedule: row.schedule,
      active: row.active,
      endedAt: row.ended_at,
      country: row.country,
      deviceTypes: devices.rows.map((d) => d.device_type),
      providers,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Todos os serviços (ativos e inativos) de um paciente, mais recente primeiro. */
  async listForPatient(patientId: string): Promise<ContractedServiceDetail[]> {
    const { rows } = await this.pool.query<ServiceRow>(
      `SELECT * FROM patient_contracted_services WHERE patient_id = $1 ORDER BY active DESC, created_at ASC`,
      [patientId],
    );
    return Promise.all(rows.map((r) => this.decorate(r, this.pool)));
  }

  async findById(serviceId: string): Promise<ContractedServiceDetail | null> {
    const { rows } = await this.pool.query<ServiceRow>(
      `SELECT * FROM patient_contracted_services WHERE id = $1`,
      [serviceId],
    );
    if (rows.length === 0) return null;
    return this.decorate(rows[0], this.pool);
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

  /** Cria um serviço contratado. `country`/autoria gravados na MESMA transação (lex C-a.1/C-a.3). */
  async create(input: CreateContractedServiceInput): Promise<ContractedServiceDetail> {
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
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
          values.push(toColumnValue(key, value));
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
      const row = await cli.query<ServiceRow>('SELECT * FROM patient_contracted_services WHERE id = $1', [serviceId]);
      await cli.query('COMMIT');
      return this.decorate(row.rows[0], this.pool);
    } catch (err) {
      await cli.query('ROLLBACK');
      if (isAddressFkViolation(err)) throw new AddressNotOfPatientError(input.addressId);
      throw err;
    } finally {
      cli.release();
    }
  }

  /**
   * Atualização PARCIAL (Merge Patch, molde `PatientClinicalRepository`): chave ausente não
   * toca a coluna. `active:false` grava `ended_at=NOW()` (baixa, C-a.4); `active` nunca volta a
   * `true` por este caminho (reabrir não existe — o CHECK `pcs_active_ended_coerente` também
   * bloquearia `active:true` com `ended_at` preexistente sem limpar a data, então o controller
   * nunca envia essa combinação).
   */
  async update(serviceId: string, patch: ContractedServiceWriteInput): Promise<ContractedServiceDetail | null> {
    const cli = await this.pool.connect();
    try {
      await cli.query('BEGIN');
      const sets: string[] = [];
      const params: unknown[] = [serviceId];
      const push = (col: string, value: unknown): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };
      for (const [key, col] of WRITABLE_COLUMNS) {
        const value = patch[key];
        if (value !== undefined) push(col, toColumnValue(key, value));
      }
      if (patch.active !== undefined) {
        push('active', patch.active);
        sets.push(patch.active ? 'ended_at = NULL' : 'ended_at = NOW()');
      }
      if (patch.deviceTypeCodes !== undefined) {
        await this.replaceDevices(serviceId, patch.deviceTypeCodes, cli);
      }
      if (sets.length > 0) {
        params.push(patch.actorUid);
        sets.push(`updated_by = $${params.length}`);
        sets.push('updated_at = NOW()');
        const res = await cli.query(`UPDATE patient_contracted_services SET ${sets.join(', ')} WHERE id = $1`, params);
        if ((res.rowCount ?? 0) === 0) {
          await cli.query('ROLLBACK');
          return null;
        }
      }
      const row = await cli.query<ServiceRow>('SELECT * FROM patient_contracted_services WHERE id = $1', [serviceId]);
      await cli.query('COMMIT');
      if (row.rows.length === 0) return null;
      return this.decorate(row.rows[0], this.pool);
    } catch (err) {
      await cli.query('ROLLBACK');
      if (isAddressFkViolation(err)) throw new AddressNotOfPatientError(patch.addressId);
      throw err;
    } finally {
      cli.release();
    }
  }
}
