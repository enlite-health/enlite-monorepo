import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { CountryCode } from '@shared/domain/countryCodes';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { fetchPatientDetail } from './PatientDetailQueryHelper';
import type { AdminPatientsListParams } from '../interfaces/validators/adminPatientsListSchema';
import { derivePatientSla } from '../domain/PatientSla';
import { isLeadPlaceholderName } from '../domain/LeadContact';
import { attachLeadContact } from './PatientLeadContactAttacher';
import { ALL_PATIENT_CONTAINERS_READABLE, type PatientContainerReads } from '../application/patientContainerAccess';
import {
  computePatientCompleteness,
  ACTIVATABLE_STATUSES,
  INCOMPLETE_ADMISSION_REASON,
  patientNeedsAttentionSql,
  patientHasAttentionReasonSql,
} from '../domain/PatientCompleteness';

// ── Read model ────────────────────────────────────────────────────────────────
// Os shapes moram em `PatientQueryRows.ts` (teto de 400 linhas). Re-exportados aqui para
// que este arquivo continue sendo a porta pública deles — `export type` some na compilação.
import type { PatientDetailRow, PatientListRow, PatientStatsRow } from './PatientQueryRows';
export type {
  PatientResponsibleDetail,
  PatientAddressDetail,
  PatientProfessionalDetail,
  PatientDetailRow,
  PatientListRow,
  PatientStatsRow,
} from './PatientQueryRows';

/**
 * PatientQueryRepository — read-only queries for admin patient listing and detail.
 *
 * Kept separate from PatientIdentityRepository to respect
 * single-responsibility: identity repo owns upsert/findById; this repo
 * owns list/stats queries that cross identity + clinical columns.
 *
 * findDetailById also decrypts PII from patient_responsibles and
 * patient_professionals using KMSEncryptionService (passthrough in test env).
 */
export class PatientQueryRepository {
  private pool: Pool;
  private readonly encryptionService: KMSEncryptionService;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
  }

  async list(
    filters: AdminPatientsListParams,
    // D286 / lex P3: o desempate do lead (e-mail mascarado) só é descriptografado para quem lê identidade.
    reads: PatientContainerReads = ALL_PATIENT_CONTAINERS_READABLE,
  ): Promise<{ rows: PatientListRow[]; total: number }> {
    const params: unknown[] = [];
    let i = 1;

    // $1 search term (null = no filter)
    params.push(filters.search?.trim() || null);
    const searchIdx = i++;

    // $2 needs_attention boolean (null = no filter)
    const needsAttentionBool =
      filters.needs_attention === 'true'
        ? true
        : filters.needs_attention === 'false'
          ? false
          : null;
    params.push(needsAttentionBool);
    const needsAttentionIdx = i++;

    // $3 attention_reason string (null = no filter)
    params.push(filters.attention_reason ?? null);
    const attentionReasonIdx = i++;

    // $4 clinical_specialty (null = no filter)
    params.push(filters.clinical_specialty ?? null);
    const clinicalSpecialtyIdx = i++;

    // $5 dependency_level (null = no filter)
    params.push(filters.dependency_level ?? null);
    const dependencyLevelIdx = i++;

    // $6 case_number partial filter (null = no filter)
    params.push(filters.case_number ?? null);
    const caseNumberIdx = i++;

    // $7 country filter (null = todos os países)
    params.push(filters.country ?? null);
    const countryIdx = i++;

    // lex 08/09 (gate da LISTA 017): o ramo da busca que casa o NOME DO RESPONSÁVEL é dado do container
    // família — sem `patient_family:read` o ramo desliga (a busca por nome do paciente é guardada no controller
    // pela célula de identidade; este é o segundo oráculo, na mesma cláusula).
    params.push(reads.family);
    const familyIdx = i++;

    // $9 limit, $10 offset ($8 é reads.family, o ramo do responsável na busca)
    params.push(filters.limit);
    const limitIdx = i++;
    params.push(filters.offset);
    const offsetIdx = i++;

    // Effective case_number: patients.case_number when populated, otherwise
    // fall back to the MAX case_number across this patient's active vagas.
    const effectiveCaseNumber = `
      COALESCE(
        p.case_number,
        (SELECT MAX(jp.case_number)
           FROM job_postings jp
          WHERE jp.patient_id = p.id
            AND jp.deleted_at IS NULL)
      )
    `;

    const sql = `
      SELECT
        id,
        clickup_task_id        AS "clickupTaskId",
        first_name             AS "firstName",
        last_name              AS "lastName",
        diagnosis,
        dependency_level       AS "dependencyLevel",
        clinical_specialty     AS "clinicalSpecialty",
        service_type           AS "serviceType",
        document_type          AS "documentType",
        document_number        AS "documentNumber",
        sex,
        status,
        admission_status       AS "admissionStatus",
        needs_attention        AS "needsAttention",
        is_test                AS "isTest",
        attention_reasons      AS "attentionReasons",
        (SELECT COUNT(*) FROM patient_addresses pa
          WHERE pa.patient_id = p.id AND pa.archived_at IS NULL)::int
                               AS "addressesCount",
        (${effectiveCaseNumber})::int
                               AS "caseNumber",
        -- QA-caça rodada 1, item conserto 1 (D1.1/D255): insumos de computePatientCompleteness
        -- para DERIVAR needsAttention/attentionReasons aqui mesmo — nunca missing[] sai desta
        -- query (só os booleanos). EXISTS/booleano (correlated subquery, UMA query só — sem
        -- N+1 em código); ADDRESS reusa "addressesCount" acima em vez de duplicar o EXISTS.
        -- Nenhuma coluna cifrada (KMS) entra aqui: has_consent/birth_date/insurance_informed
        -- não são PII encriptada.
        p.birth_date            AS "birthDate",
        p.has_consent           AS "hasConsent",
        COALESCE(p.insurance_informed, p.health_insurance_name)
                               AS "insuranceInformed",
        -- AND pr.active (spec 018, PR-1, FR-004): responsável desativado não conta como
        -- presente — mesma régua de MISSING_SQL.RESPONSIBLE (PatientCompleteness.ts).
        EXISTS (SELECT 1 FROM patient_responsibles pr
                 WHERE pr.patient_id = p.id AND pr.active)
                               AS "hasActiveResponsible",
        EXISTS (SELECT 1 FROM patient_contracted_services pcs
                 WHERE pcs.patient_id = p.id AND pcs.active)
                               AS "hasActiveContractedService",
        -- Migration 330: serviço ativo sem endereço vivo (NULL ou arquivado) → SERVICE_ADDRESS.
        EXISTS (SELECT 1 FROM patient_contracted_services pcs
                 LEFT JOIN patient_addresses pa
                        ON pa.id = pcs.address_id AND pa.archived_at IS NULL
                 WHERE pcs.patient_id = p.id AND pcs.active AND pa.id IS NULL)
                               AS "hasActiveServiceWithoutAddress",
        -- Decisão do Gabriel 07/09: serviço ativo sem horário (NULL ou array vazio) → SERVICE_SCHEDULE.
        EXISTS (SELECT 1 FROM patient_contracted_services pcs
                 WHERE pcs.patient_id = p.id AND pcs.active
                   AND (pcs.schedule IS NULL OR jsonb_array_length(pcs.schedule) = 0))
                               AS "hasActiveServiceWithoutSchedule",
        created_at             AS "createdAt",
        updated_at             AS "updatedAt",
        -- SLA (Fase 4): quando o paciente entrou no status ATUAL. MAX(created_at)
        -- do histórico para new_value = status atual; fallback = created_at do
        -- paciente (legado sem histórico / status recém-atribuído).
        COALESCE(
          (SELECT MAX(psh.created_at)
             FROM patient_status_history psh
            WHERE psh.patient_id = p.id
              AND psh.new_value = p.status),
          p.created_at
        )                      AS "stageEnteredAt",
        -- Contato do lead sem nome: ciphertext apenas. A descriptografia é
        -- feita DEPOIS, e só nas linhas com placeholder (C2/C4).
        p.contact_email_encrypted
                               AS "contactEmailEnc",
        -- AND r.active nas 2 subqueries abaixo (spec 018, PR-1, FR-004): um titular
        -- DESATIVADO não é mais "o responsável primário" para a lista — sem o filtro, desativar
        -- o titular não trocava quem a lista mostra (o índice de titular único já passou a
        -- olhar só ativos na migration 420; a leitura tinha de acompanhar).
        (SELECT r.email_encrypted
           FROM patient_responsibles r
          WHERE r.patient_id = p.id
            AND r.is_primary
            AND r.active
          ORDER BY r.display_order, r.created_at
          LIMIT 1)            AS "responsibleEmailEnc",
        -- Nome do responsável primário (D249). Texto claro, sem KMS: a coluna
        -- não é cifrada. É o que a lista mostra quando o paciente ainda não tem
        -- nome — o lead "para otra persona" nasce assim.
        (SELECT NULLIF(btrim(concat_ws(' ', r.first_name, NULLIF(r.last_name, ''))), '')
           FROM patient_responsibles r
          WHERE r.patient_id = p.id
            AND r.is_primary
            AND r.active
          ORDER BY r.display_order, r.created_at
          LIMIT 1)            AS "responsibleName",
        COUNT(*) OVER()        AS total_count
      FROM patients p
      WHERE
        ($${searchIdx}::text IS NULL
          OR p.first_name    ILIKE '%' || $${searchIdx} || '%'
          OR p.last_name     ILIKE '%' || $${searchIdx} || '%'
          OR p.document_number ILIKE '%' || $${searchIdx} || '%'
          -- D249: a lista mostra "Responsável: X" quando o paciente não tem
          -- nome. Sem isto, o operador lê um nome na tela, digita esse nome na
          -- busca e não acha nada — que é pior do que não mostrar.
          OR ($${familyIdx}::boolean AND EXISTS (
               SELECT 1 FROM patient_responsibles r
                WHERE r.patient_id = p.id
                  AND r.active
                  AND (r.first_name ILIKE '%' || $${searchIdx} || '%'
                    OR r.last_name  ILIKE '%' || $${searchIdx} || '%'))))
        -- O filtro e o total leem a MESMA regra que o payload publica (PatientCompleteness.ts):
        -- ler a coluna guardada aqui fazia o paciente com badge SUMIR quando a operadora
        -- filtrava por ele, e INCOMPLETE_ADMISSION nunca casar com ninguém.
        AND ($${needsAttentionIdx}::boolean IS NULL OR ${patientNeedsAttentionSql('p')} = $${needsAttentionIdx})
        AND ($${attentionReasonIdx}::text IS NULL OR ${patientHasAttentionReasonSql(`$${attentionReasonIdx}`, 'p')})
        AND ($${clinicalSpecialtyIdx}::text IS NULL OR p.clinical_specialty = $${clinicalSpecialtyIdx})
        AND ($${dependencyLevelIdx}::text IS NULL OR p.dependency_level = $${dependencyLevelIdx})
        AND ($${caseNumberIdx}::text IS NULL
          OR CAST((${effectiveCaseNumber}) AS TEXT) ILIKE '%' || $${caseNumberIdx} || '%')
        AND ($${countryIdx}::text IS NULL OR p.country = $${countryIdx})
        AND p.deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;

    const result = await this.pool.query(sql, params);

    const total =
      result.rows.length > 0
        ? parseInt(result.rows[0].total_count as string, 10)
        : 0;

    const now = new Date();
    const rows: PatientListRow[] = result.rows.map((row) => {
      const stageEnteredAt =
        row.stageEnteredAt != null ? new Date(row.stageEnteredAt as string) : null;
      const sla = derivePatientSla(row.status, stageEnteredAt, now);
      const addressesCountNum = parseInt(row.addressesCount as unknown as string, 10) || 0;

      // QA-caça rodada 1, item conserto 1 (D1.1/D255): a MESMA função do checklist decide se
      // esta linha está incompleta — nunca uma cópia da regra. `missing[]` fica só aqui dentro
      // (nunca sai no payload da lista/kanban — lex D1.1); o que sai é needsAttention/
      // attentionReasons, já OR-ados com o legado.
      const { missing } = computePatientCompleteness({
        birthDate: (row.birthDate as string | Date | null) ?? null,
        hasConsent: (row.hasConsent as boolean | null) ?? null,
        insuranceInformed: (row.insuranceInformed as string | null) ?? null,
        activeAddressCount: addressesCountNum,
        activeResponsibleCount: row.hasActiveResponsible === true ? 1 : 0,
        activeContractedServiceCount: row.hasActiveContractedService === true ? 1 : 0,
        activeContractedServicesWithoutAddressCount: row.hasActiveServiceWithoutAddress === true ? 1 : 0,
        activeContractedServicesWithoutScheduleCount:
          row.hasActiveServiceWithoutSchedule === true ? 1 : 0,
        now,
      });
      const isActivatableStatus = (ACTIVATABLE_STATUSES as readonly (string | null)[]).includes(
        row.status as string | null,
      );
      const incompleteAdmission = isActivatableStatus && missing.length > 0;
      const needsAttentionDerived = row.needsAttention === true || incompleteAdmission;
      const legacyReasons: string[] = row.attentionReasons ?? [];
      const attentionReasonsDerived = incompleteAdmission
        ? legacyReasons.includes(INCOMPLETE_ADMISSION_REASON)
          ? legacyReasons
          : [...legacyReasons, INCOMPLETE_ADMISSION_REASON]
        : legacyReasons;

      return {
        id: row.id,
        isTest: row.isTest === true,
        clickupTaskId: row.clickupTaskId,
        firstName: row.firstName,
        lastName: row.lastName,
        diagnosis: row.diagnosis,
        dependencyLevel: row.dependencyLevel,
        clinicalSpecialty: row.clinicalSpecialty,
        serviceType: row.serviceType,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        sex: row.sex,
        status: row.status,
        admissionStatus: (row.admissionStatus as string | null) ?? 'DONE',
        needsAttention: needsAttentionDerived,
        attentionReasons: attentionReasonsDerived,
        addressesCount: addressesCountNum,
        caseNumber: row.caseNumber != null ? parseInt(row.caseNumber as unknown as string, 10) : null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        stageEnteredAt: sla.stageEnteredAt,
        hoursInStage: sla.hoursInStage,
        slaThresholdHours: sla.slaThresholdHours,
        slaBreached: sla.slaBreached,
        // Nome de quem responde pelo paciente — a lista cai nele quando o
        // paciente ainda não tem nome próprio (D249).
        // O placeholder da era pré-D249 também contaminou os responsáveis: as 6
        // fichas antigas com familiar têm 'Solicitante' ali. Mostrar
        // "Responsável: Solicitante" seria trocar um card mudo por outro.
        responsibleName: isLeadPlaceholderName(row.responsibleName as string | null, null)
          ? null
          : ((row.responsibleName as string | null) ?? null),
        // Preenchidos na segunda passada, só para as fichas com placeholder.
        leadContactEmailMasked: null,
        leadContactIsResponsible: false,
      };
    });

    if (reads.identity) await attachLeadContact(this.encryptionService, rows, result.rows);

    return { rows, total };
  }

  /**
   * @param countries escopo de país já resolvido (PR-9, `lex` #9) — nunca um
   *   `undefined`/"sem filtro" solto: quem chama (`resolveCountryScope`) sempre
   *   entrega um array não-vazio, interseção do pedido com o escopo do ator.
   */
  async stats(countries: CountryCode[]): Promise<PatientStatsRow> {
    const result = await this.pool.query<{
      total: string;
      complete: string;
      needs_attention: string;
      created_today: string;
      created_yesterday: string;
      created_last_7_days: string;
    }>(`
      SELECT
        COUNT(*)::int                                                                 AS total,
        -- Os contadores leem a MESMA regra do badge (PatientCompleteness.ts): contar a coluna
        -- guardada dava "Completo" para quem a lista mostra com "Necesita atención".
        COUNT(*) FILTER (WHERE NOT ${patientNeedsAttentionSql('p')})::int             AS complete,
        COUNT(*) FILTER (WHERE ${patientNeedsAttentionSql('p')})::int                 AS needs_attention,
        COUNT(*) FILTER (WHERE p.created_at >= date_trunc('day', NOW()))::int        AS created_today,
        COUNT(*) FILTER (
          WHERE p.created_at >= date_trunc('day', NOW() - INTERVAL '1 day')
            AND p.created_at <  date_trunc('day', NOW())
        )::int                                                                       AS created_yesterday,
        COUNT(*) FILTER (WHERE p.created_at >= NOW() - INTERVAL '7 days')::int      AS created_last_7_days
      FROM patients p
      WHERE p.deleted_at IS NULL
        AND p.country = ANY($1::bpchar[])
    `, [countries]);

    const row = result.rows[0];
    return {
      total: parseInt(row.total, 10),
      complete: parseInt(row.complete, 10),
      needsAttention: parseInt(row.needs_attention, 10),
      createdToday: parseInt(row.created_today, 10),
      createdYesterday: parseInt(row.created_yesterday, 10),
      createdLast7Days: parseInt(row.created_last_7_days, 10),
    };
  }

  /** Full patient detail with decrypted PII. Delegates to PatientDetailQueryHelper. */
  async findDetailById(id: string, reads: PatientContainerReads = ALL_PATIENT_CONTAINERS_READABLE): Promise<PatientDetailRow | null> {
    return fetchPatientDetail(this.pool, this.encryptionService, id, reads);
  }
}
