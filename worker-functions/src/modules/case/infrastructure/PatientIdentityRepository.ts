import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { PatientIdentity } from '../domain/PatientIdentity';
import type { Sex } from '../domain/enums/Sex';
import type { DocumentType } from '../domain/enums/DocumentType';
import type { AttentionReason } from '../domain/enums/AttentionReason';
import type { PatientStatus } from '../domain/enums/PatientStatus';
import {
  isAdmissionCountry,
  type AdmissionCountry,
} from '../../matching/domain/admissionCountries';

export interface PatientIdentityUpsertInput {
  clickupTaskId: string;
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | null;
  documentType?: DocumentType | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `document_type` não é tocada (I2).
   *
   * Mesma bandeira de `insuranceVerifiedReadable`, estendida aos irmãos que ficaram de fora:
   * `Tipo de Documento Paciente` é `drop_down`, e uma opção que deixa de resolver devolvia
   * `null`, que o `document_type = EXCLUDED.document_type` gravava como APAGAMENTO.
   * Ausente = `true`, para que nenhum chamador antigo pare de escrever em silêncio.
   */
  documentTypeReadable?: boolean;
  documentNumber?: string | null;
  affiliateId?: string | null;
  sex?: Sex | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `sex` não é tocada (I2).
   * Exposição medida do apagamento antes desta bandeira: 185 linhas de `sex`.
   */
  sexReadable?: boolean;
  phoneWhatsapp?: string | null;
  insuranceInformed?: string | null;
  insuranceVerified?: string | null;
  /**
   * A leitura da origem foi POSSÍVEL? `false` ⇒ `insurance_verified` não é tocada.
   *
   * ⚠️ Este campo existia no mapper e no `PatientService` desde a task 3.2 e **nunca era
   * consumido aqui** — o `lex` achou (C-G). O mapper emitia o sinal, o tipo o declarava, um
   * comentário dizia que era "a mesma distinção da D167", e o `UPDATE` gravava `?? null` de
   * qualquer jeito. Uma leitura `options_partially_resolved` (pediu 2 rótulos, o catálogo
   * traduziu 1) zerava a coluna que o painel lê, enquanto a tabela múltipla — corretamente —
   * não era tocada: banco cheio, tela vazia.
   *
   * Ausente = `true`, para que nenhum chamador antigo pare de escrever em silêncio.
   */
  insuranceVerifiedReadable?: boolean;
  cityLocality?: string | null;
  province?: string | null;
  zoneNeighborhood?: string | null;
  country?: string;
  needsAttention?: boolean;
  attentionReasons?: readonly AttentionReason[];
  /**
   * Cobertura médica informada (ClickUp: "Cobertura Informada"). Migration 147.
   * Fill-only: COALESCE(existing, $new) — never overwrites a populated value.
   */
  healthInsuranceName?: string | null;
  /**
   * Número de ID de afiliado (ClickUp: "Número ID Afiliado Paciente"). Migration 147.
   * Fill-only: COALESCE(existing, $new) — never overwrites a populated value.
   */
  healthInsuranceMemberId?: string | null;
  /**
   * Identificador PII-safe operacional (ClickUp "Caso Número"). Migration 164.
   * Origem: string no payload ClickUp; aqui já parseado para number.
   * UNIQUE entre patients ativos (deleted_at IS NULL) — conflito é tratado
   * no handler do webhook (próxima etapa).
   */
  caseNumber?: number | null;
  /**
   * Lifecycle status derived from ClickUp task status (migration 143).
   * Mapped via vacancyStatusMap.ts: patientStatus field.
   * null when the ClickUp status is unrecognised (new/unlisted status).
   */
  status?: PatientStatus | null;
}

/** Where a native patient was created (never 'clickup' — that's the sync path). Migration 251. */
export type NativePatientOrigin = 'web_form' | 'admin_manual';

/**
 * Input for a NATIVE patient insert (migration 251) — a patient born inside
 * Enlite, not synced from ClickUp. Sibling of PatientIdentityUpsertInput but:
 *   - no clickupTaskId (persisted as NULL)
 *   - carries `origin` (web_form | admin_manual) + a required `status`
 *   - carries `contactEmailEncrypted` (KMS ciphertext, encrypted upstream in
 *     PatientService using the SAME KMSEncryptionService as the responsibles)
 */
export interface PatientIdentityNativeInsertInput
  extends Omit<PatientIdentityUpsertInput, 'clickupTaskId' | 'status' | 'country'> {
  origin: NativePatientOrigin;
  status: PatientStatus;
  /** Required & narrowed on the native path — see publicLeadSchema (D108).
   * The ClickUp upsert path keeps its 'AR' default: that list IS the AR operation. */
  country: AdmissionCountry;
  /** KMS ciphertext (base64) of the contact email. Encrypted by the caller. */
  contactEmailEncrypted?: string | null;
}

/**
 * PatientIdentityRepository — persists non-clinical patient fields.
 * Backed by Postgres (always). Future: remains in case-service MS.
 * Does NOT join workers, job_postings, or any domain outside patient.
 */
export class PatientIdentityRepository {
  private pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  async upsert(
    input: PatientIdentityUpsertInput,
    client?: PoolClient,
  ): Promise<{ id: string; created: boolean }> {
    const executor = client ?? this.pool;
    const country = input.country ?? 'AR';

    const result = await executor.query<{ id: string; xmax: string }>(
      `INSERT INTO patients (
        clickup_task_id,
        first_name, last_name, birth_date,
        document_type, document_number, affiliate_id,
        sex, phone_whatsapp,
        insurance_informed, insurance_verified,
        city_locality, province, zone_neighborhood,
        country,
        needs_attention, attention_reasons,
        health_insurance_name, health_insurance_member_id,
        case_number,
        status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
      ON CONFLICT (clickup_task_id) DO UPDATE SET
        first_name          = EXCLUDED.first_name,
        last_name           = EXCLUDED.last_name,
        birth_date          = EXCLUDED.birth_date,
        -- I2: os dois CASE WHEN abaixo são a MESMA bandeira do insurance_verified logo
        -- adiante. false = "não consegui ler a opção" ⇒ a coluna fica como está; true com
        -- valor nulo continua APAGANDO (vazio legítimo, D-E). Só no DO UPDATE: o INSERT é linha
        -- nova e não tem o que apagar.
        document_type       = CASE WHEN $23::boolean THEN EXCLUDED.document_type ELSE patients.document_type END,
        document_number     = EXCLUDED.document_number,
        affiliate_id        = EXCLUDED.affiliate_id,
        sex                 = CASE WHEN $24::boolean THEN EXCLUDED.sex ELSE patients.sex END,
        phone_whatsapp      = EXCLUDED.phone_whatsapp,
        insurance_informed  = EXCLUDED.insurance_informed,
        insurance_verified  = CASE WHEN $22::boolean THEN EXCLUDED.insurance_verified ELSE patients.insurance_verified END,
        city_locality       = EXCLUDED.city_locality,
        province            = EXCLUDED.province,
        zone_neighborhood   = EXCLUDED.zone_neighborhood,
        needs_attention     = EXCLUDED.needs_attention,
        attention_reasons   = EXCLUDED.attention_reasons,
        -- fill-only: only update when the current DB value is NULL
        health_insurance_name       = COALESCE(patients.health_insurance_name, EXCLUDED.health_insurance_name),
        health_insurance_member_id  = COALESCE(patients.health_insurance_member_id, EXCLUDED.health_insurance_member_id),
        case_number         = EXCLUDED.case_number,
        -- status: always overwrite. 11/09/2026: a PLATAFORMA é a fonte da verdade do paciente
        -- (decisão do Gabriel, sem sync automático) — este UPSERT só roda hoje na carga manual
        -- pontual de paciente NOVO (scripts/import-patients-from-clickup.ts --task-id --apply,
        -- que recusa UPDATE de paciente já existente antes de chegar aqui). Overwrite
        -- incondicional continua correto porque, nesse caminho, EXCLUDED é sempre o primeiro
        -- valor que o registro recebe.
        status              = EXCLUDED.status,
        updated_at          = NOW()
      RETURNING id, xmax::text`,
      [
        input.clickupTaskId,
        input.firstName        ?? null,
        input.lastName         ?? null,
        input.birthDate        ?? null,
        input.documentType     ?? null,
        input.documentNumber   ?? null,
        input.affiliateId      ?? null,
        input.sex              ?? null,
        input.phoneWhatsapp    ?? null,
        input.insuranceInformed ?? null,
        input.insuranceVerified ?? null,
        input.cityLocality      ?? null,
        input.province          ?? null,
        input.zoneNeighborhood  ?? null,
        country,
        input.needsAttention   ?? false,
        input.attentionReasons ? [...input.attentionReasons] : [],
        // $22 — a bandeira da C-G. NÃO entra no INSERT (que é linha nova, sempre escreve);
        // só no ON CONFLICT DO UPDATE, que é onde apagar é possível.
        input.healthInsuranceName      ?? null,
        input.healthInsuranceMemberId  ?? null,
        input.caseNumber       ?? null,
        input.status           ?? null,
        input.insuranceVerifiedReadable ?? true,   // $22 — a bandeira da C-G
        input.documentTypeReadable      ?? true,   // $23 — a bandeira do I2
        input.sexReadable               ?? true,   // $24 — a bandeira do I2
      ],
    );

    const row = result.rows[0];
    return { id: row.id, created: row.xmax === '0' };
  }

  /**
   * Inserts a NATIVE patient (migration 251) — clickup_task_id NULL, explicit
   * `origin` + `status`, optional KMS-encrypted contact email. Sibling of
   * `upsert` but with NO `ON CONFLICT`: native creation is always a fresh row
   * (there is no ClickUp task to reconcile against), so it always returns
   * `{ created: true }`.
   *
   * Caller (PatientService.createNativePatient) runs this inside the same
   * transaction that writes clinical/responsibles/addresses/professionals.
   */
  async insertNative(
    input: PatientIdentityNativeInsertInput,
    client?: PoolClient,
  ): Promise<{ id: string; created: true }> {
    const executor = client ?? this.pool;
    // Runtime backstop for casted/JS callers the compiler can't see: without it
    // an invalid country surfaces as an opaque 23502/23514 mid-transaction.
    if (!isAdmissionCountry(input.country)) {
      throw new Error(`insertNative: invalid country ${JSON.stringify(input.country)} — must be AR|BR (D108)`);
    }

    const result = await executor.query<{ id: string }>(
      `INSERT INTO patients (
        clickup_task_id,
        origin, contact_email_encrypted,
        first_name, last_name, birth_date,
        document_type, document_number, affiliate_id,
        sex, phone_whatsapp,
        insurance_informed, insurance_verified,
        city_locality, province, zone_neighborhood,
        country,
        needs_attention, attention_reasons,
        health_insurance_name, health_insurance_member_id,
        case_number,
        status
      ) VALUES (
        NULL,
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
      )
      RETURNING id`,
      [
        input.origin,
        input.contactEmailEncrypted ?? null,
        input.firstName        ?? null,
        input.lastName         ?? null,
        input.birthDate        ?? null,
        input.documentType     ?? null,
        input.documentNumber   ?? null,
        input.affiliateId      ?? null,
        input.sex              ?? null,
        input.phoneWhatsapp    ?? null,
        input.insuranceInformed ?? null,
        input.insuranceVerified ?? null,
        input.cityLocality      ?? null,
        input.province          ?? null,
        input.zoneNeighborhood  ?? null,
        input.country,
        input.needsAttention   ?? false,
        input.attentionReasons ? [...input.attentionReasons] : [],
        input.healthInsuranceName      ?? null,
        input.healthInsuranceMemberId  ?? null,
        input.caseNumber       ?? null,
        input.status,
      ],
    );

    return { id: result.rows[0].id, created: true };
  }

  async findById(id: string): Promise<PatientIdentity | null> {
    const result = await this.pool.query<PatientIdentity>(
      `SELECT
        id, clickup_task_id AS "clickupTaskId",
        first_name AS "firstName", last_name AS "lastName",
        birth_date AS "birthDate", document_type AS "documentType",
        document_number AS "documentNumber", affiliate_id AS "affiliateId",
        sex, phone_whatsapp AS "phoneWhatsapp",
        insurance_informed AS "insuranceInformed",
        insurance_verified AS "insuranceVerified",
        city_locality AS "cityLocality", province,
        zone_neighborhood AS "zoneNeighborhood",
        country,
        COALESCE((SELECT jsonb_object_agg(c.role, c.chat_id)
                    FROM patient_chat_ids c
                   WHERE c.patient_id = p.id), '{}'::jsonb) AS "chatIds",
        needs_attention AS "needsAttention",
        attention_reasons AS "attentionReasons",
        created_at AS "createdAt", updated_at AS "updatedAt"
       FROM patients p WHERE p.id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }
}
