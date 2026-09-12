import type { Pool } from 'pg';
import type { GeocodingService } from '../../../infrastructure/services/GeocodingService';

/**
 * PatientAddressQueryHelper — a PERSISTÊNCIA dos endereços de um paciente pelo caminho do
 * painel (`POST`/`GET /api/admin/patients/:patientId/addresses`).
 *
 * Extraído de `AdminPatientsController` para manter aquele arquivo dentro do teto de 400 linhas
 * do `CLAUDE.md`, e para tirar SQL de dentro de um controller ("controllers não contêm lógica
 * de negócio" — mesma regra, mesmo arquivo). É o molde que este módulo já usa em
 * `PatientStatusHistoryQueryHelper` e `PatientVacanciesQueryHelper`.
 *
 * Spec 019 (D310 item c, override do `lex` 12/09/2026): `address_type` deixa de ser aceito na
 * criação — nasce `NULL` ("sin especificar"), atribuído depois pelo PATCH
 * (`AdminPatientAddressesController`, único escritor de valor autorizado). `is_default` é a marca
 * de PRINCIPAL própria (não mais deduzida de `address_type = 'primary'`): no máximo uma ativa por
 * paciente (índice único parcial `patient_addresses_one_default_per_patient`, migration 433).
 *
 * Regra de nascimento (spec 019, seção "API"): endereço criado para paciente SEM principal ativo
 * nasce principal mesmo que o cliente não peça (`isDefault` omitido). Quando o cliente pede
 * explicitamente (`isDefault: true`), o principal anterior é desmarcado NA MESMA TRANSAÇÃO —
 * nunca existe instante observável com 0 ou 2 principais.
 */

export interface CreatePatientAddressInput {
  patientId: string;
  addressFormatted: string;
  addressRaw: string | null;
  /** Marca de principal — `true`/`false` explícitos, ou `undefined` para a regra de nascimento. */
  isDefault?: boolean;
  displayOrder: number | null;
  neighborhood: string | null;
  logisticsCorridor: string | null;
  accessNotes: string | null;
}

export interface CreatedPatientAddress {
  id: string;
  patient_id: string;
  address_formatted: string;
  address_raw: string | null;
  is_default: boolean;
}

export interface PatientAddressRow {
  id: string;
  address_formatted: string;
  address_raw: string | null;
  address_type: string | null;
  is_default: boolean;
  display_order: number | null;
  source: string | null;
  complement: string | null;
  lat: string | null;
  lng: string | null;
}

export async function insertPatientAddress(
  db: Pool,
  geocoder: GeocodingService,
  input: CreatePatientAddressInput,
): Promise<CreatedPatientAddress> {
  // Best-effort geocode — failures persist with lat/lng=NULL and the
  // backfill job recovers later.
  let lat: number | null = null;
  let lng: number | null = null;
  try {
    const geo = await geocoder.geocode(input.addressFormatted);
    if (geo) {
      lat = geo.latitude;
      lng = geo.longitude;
    }
  } catch {
    // best-effort
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    let isDefault: boolean;
    if (input.isDefault === true) {
      // Marca explícita: desmarca o principal anterior NA MESMA TRANSAÇÃO (troca atômica).
      await client.query(
        `UPDATE patient_addresses SET is_default = false
          WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
        [input.patientId],
      );
      isDefault = true;
    } else if (input.isDefault === false) {
      isDefault = false;
    } else {
      // Regra de nascimento (spec 019): sem principal ativo, este nasce principal.
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL
         ) AS exists`,
        [input.patientId],
      );
      isDefault = !rows[0].exists;
    }

    // `country` explícito, do paciente (mig 316, lex C2.8) — o trigger cobre quem não manda;
    // aqui mandamos mesmo assim, para o INSERT dizer o que faz. `address_type` NÃO entra aqui
    // (spec 019, B4): nasce NULL, só o PATCH escreve valor.
    const result = await client.query<CreatedPatientAddress>(
      `INSERT INTO patient_addresses
         (patient_id, address_formatted, address_raw, display_order, source, lat, lng,
          neighborhood, logistics_corridor, access_notes, country, is_default)
       VALUES ($1, $2, $3,
         COALESCE($4, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL)),
         'admin_manual', $5, $6, $7, $8, $9,
         (SELECT country FROM patients WHERE id = $1), $10)
       RETURNING id, patient_id, address_formatted, address_raw, is_default`,
      [input.patientId, input.addressFormatted, input.addressRaw, input.displayOrder, lat, lng,
        input.neighborhood, input.logisticsCorridor, input.accessNotes, isDefault],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function fetchPatientAddresses(db: Pool, patientId: string): Promise<PatientAddressRow[]> {
  const result = await db.query<PatientAddressRow>(
    // archived_at IS NULL: o form de criação de vaga e o detalhe do
    // paciente só veem endereços ativos. Endereços arquivados continuam
    // existindo na tabela pra preservar o histórico das vagas antigas
    // que apontam pra eles (ver migration 198 e docs/features/
    // vacancy-creation/06-endereco-servico.md).
    `SELECT id, address_formatted, address_raw, address_type, is_default, display_order, source, complement, lat, lng
     FROM patient_addresses
     WHERE patient_id = $1
       AND archived_at IS NULL
     ORDER BY display_order ASC, created_at ASC`,
    [patientId],
  );
  return result.rows;
}
