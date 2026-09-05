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
 * Nada de comportamento mudou de lugar: mesmas colunas, mesmo `COALESCE` do `display_order`,
 * mesma `source = 'admin_manual'`, mesmo `country` vindo do paciente, mesmo geocode
 * best-effort (falha persiste `lat/lng = NULL` e o backfill recupera depois).
 */

export interface CreatePatientAddressInput {
  patientId: string;
  addressFormatted: string;
  addressRaw: string | null;
  addressType: string;
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
  address_type: string;
}

export interface PatientAddressRow {
  id: string;
  address_formatted: string;
  address_raw: string | null;
  address_type: string;
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

  const result = await db.query<CreatedPatientAddress>(
    // `country` explícito, do paciente (mig 316, lex C2.8) — o trigger cobre quem não manda;
    // aqui mandamos mesmo assim, para o INSERT dizer o que faz.
    `INSERT INTO patient_addresses
       (patient_id, address_formatted, address_raw, address_type, display_order, source, lat, lng,
        neighborhood, logistics_corridor, access_notes, country)
     VALUES ($1, $2, $3, $4,
       COALESCE($5, (SELECT COALESCE(MAX(display_order), 0) + 1 FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL)),
       'admin_manual', $6, $7, $8, $9, $10,
       (SELECT country FROM patients WHERE id = $1))
     RETURNING id, patient_id, address_formatted, address_raw, address_type`,
    [input.patientId, input.addressFormatted, input.addressRaw, input.addressType, input.displayOrder, lat, lng,
      input.neighborhood, input.logisticsCorridor, input.accessNotes],
  );
  return result.rows[0];
}

export async function fetchPatientAddresses(db: Pool, patientId: string): Promise<PatientAddressRow[]> {
  const result = await db.query<PatientAddressRow>(
    // archived_at IS NULL: o form de criação de vaga e o detalhe do
    // paciente só veem endereços ativos. Endereços arquivados continuam
    // existindo na tabela pra preservar o histórico das vagas antigas
    // que apontam pra eles (ver migration 198 e docs/features/
    // vacancy-creation/06-endereco-servico.md).
    `SELECT id, address_formatted, address_raw, address_type, display_order, source, complement, lat, lng
     FROM patient_addresses
     WHERE patient_id = $1
       AND archived_at IS NULL
     ORDER BY display_order ASC, created_at ASC`,
    [patientId],
  );
  return result.rows;
}
