import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { fetchPatientDetail } from './PatientDetailQueryHelper';
import type { AdminPatientsListParams } from '../interfaces/validators/adminPatientsListSchema';
import { derivePatientSla } from '../domain/PatientSla';
import { isLeadPlaceholderName, maskEmail } from '../domain/LeadContact';
import { DECRYPT_BATCH } from '@shared/security/decryptBatch';
import { logger } from '@shared/logging';

// ── Detail types ──────────────────────────────────────────────────────────────

export interface PatientResponsibleDetail {
  id: string;
  firstName: string;
  lastName: string;
  relationship: string | null;
  /** Decrypted phone or null if absent/encrypted. */
  phone: string | null;
  /** Decrypted email or null if absent/encrypted. */
  email: string | null;
  /** Decrypted document number or null. */
  documentNumber: string | null;
  documentType: string | null;
  isPrimary: boolean;
  displayOrder: number;
  source: string;
}

export interface PatientAddressDetail {
  id: string;
  addressType: string;
  addressFormatted: string | null;
  addressRaw: string | null;
  /** Address complement (Depto, Piso, andar). Manual UI entry. Migration 157. */
  complement: string | null;
  displayOrder: number;
  /** Latitude geocodificada. Migrated from job_postings.service_lat (migration 153/154). */
  lat: number | null;
  /** Longitude geocodificada. Migrated from job_postings.service_lng (migration 153/154). */
  lng: number | null;
  /** True when address_type === 'primary'. */
  isPrimary: boolean;
  /** Computed availability for this address based on active vacancies. */
  availability: import('../application/AddressAvailabilityCalculator').AddressAvailability;
}

export interface PatientProfessionalDetail {
  id: string;
  name: string;
  /** Decrypted phone or null. */
  phone: string | null;
  /** Decrypted email or null. */
  email: string | null;
  displayOrder: number;
  isTeam: boolean;
}

export interface PatientDetailRow {
  // Identity
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  birthDate: Date | null;
  documentType: string | null;
  documentNumber: string | null;
  affiliateId: string | null;
  sex: string | null;
  phoneWhatsapp: string | null;
  // Clinical
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  clinicalSegments: string | null;
  serviceType: string[] | null;
  deviceType: string | null;
  additionalComments: string | null;
  /** Autoria da última edição das observações (mig 286): ISO/Date e NOME resolvido de users. */
  additionalCommentsUpdatedAt: Date | null;
  additionalCommentsUpdatedBy: string | null;
  /** Instruções de emergência (mig 294): valor + autoria; redigido no ponto único quando o ator não pode ler. */
  emergencyInstructions: string | null;
  emergencyInstructionsUpdatedAt: Date | null;
  emergencyInstructionsUpdatedBy: string | null;
  hasJudicialProtection: boolean | null;
  hasCud: boolean | null;
  hasConsent: boolean | null;
  // Coverage
  insuranceInformed: string | null;
  insuranceVerified: string | null;
  // Location
  cityLocality: string | null;
  province: string | null;
  zoneNeighborhood: string | null;
  country: string;
  // Grupos de WhatsApp do Periskope por PAPEL (migration 261) — chave de join
  // com a auditoria de informes (Candela). Sempre @g.us. Papel ausente do mapa
  // = não vinculado.
  chatIds: Record<string, string>;
  /** @deprecated alias de `chatIds.FAMILY`; sai com a migration de contract. */
  familyChatId: string | null;
  /** @deprecated alias de `chatIds.PROVIDERS`; sai com a migration de contract. */
  providersChatId: string | null;
  // Status / flags
  status: string | null;
  needsAttention: boolean;
  attentionReasons: string[];
  // Related
  responsibles: PatientResponsibleDetail[];
  addresses: PatientAddressDetail[];
  professionals: PatientProfessionalDetail[];
  /** Last case_number across all job_postings for this patient (null if none). */
  lastCaseNumber: number | null;
  // Audit
  createdAt: Date;
  updatedAt: Date;
}

export interface PatientListRow {
  id: string;
  clickupTaskId: string;
  firstName: string | null;
  lastName: string | null;
  diagnosis: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  serviceType: string[] | null;
  documentType: string | null;
  documentNumber: string | null;
  sex: string | null;
  /** Patient lifecycle status (kanban column). Null for rows whose ClickUp status is unrecognised. */
  status: string | null;
  needsAttention: boolean;
  attentionReasons: string[];
  /** Registro sintético do synthetic monitoring — alvo do sweeper (migration 257). */
  isTest: boolean;
  /** Number of addresses linked to this patient. */
  addressesCount: number;
  /**
   * Effective case number: patients.case_number when set (newer records), or
   * MAX(job_postings.case_number) for legacy patients that only have vagas.
   * Null when neither is present.
   */
  caseNumber: number | null;
  createdAt: Date;
  updatedAt: Date;
  // ── SLA de inatividade (Fase 4, aditivo) ─────────────────────────────────
  /** Instante em que o paciente entrou no status atual (ISO), ou null. */
  stageEnteredAt: string | null;
  /** Horas inteiras no estágio atual, ou null se sem âncora. */
  hoursInStage: number | null;
  /** Teto de horas do estágio, ou null quando o estágio não tem SLA. */
  slaThresholdHours: number | null;
  /** true quando há teto e hoursInStage o ultrapassa. */
  slaBreached: boolean;
  // ── Desempate do lead sem nome (lex 30/08, C1/C2/C6) ─────────────────────
  /**
   * E-mail de contato JÁ MASCARADO (`jo***@gmail.com`), presente APENAS nas
   * fichas cujo nome é o placeholder 'Solicitante'. Ficha com nome real devolve
   * null e nem chega a ser descriptografada — o corte é aqui, no servidor, para
   * que o payload não carregue contato do board inteiro (C2).
   */
  /** Nome do responsável primário, texto claro (a coluna não é cifrada).
   *  `null` quando não há responsável — o lead "para mí" não tem. */
  responsibleName: string | null;
    leadContactEmailMasked: string | null;
  /**
   * true quando o e-mail acima é do RESPONSÁVEL, não do paciente — acontece nos
   * leads em que quem preencheu o formulário foi o familiar. Sem esta marca o
   * card mostraria contato de um terceiro sob o nome de um paciente (C6).
   */
  leadContactIsResponsible: boolean;
}

export interface PatientStatsRow {
  total: number;
  complete: number;
  needsAttention: number;
  createdToday: number;
  createdYesterday: number;
  createdLast7Days: number;
}

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

    // $8 limit, $9 offset
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
        needs_attention        AS "needsAttention",
        is_test                AS "isTest",
        attention_reasons      AS "attentionReasons",
        (SELECT COUNT(*) FROM patient_addresses pa
          WHERE pa.patient_id = p.id AND pa.archived_at IS NULL)::int
                               AS "addressesCount",
        (${effectiveCaseNumber})::int
                               AS "caseNumber",
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
        (SELECT r.email_encrypted
           FROM patient_responsibles r
          WHERE r.patient_id = p.id
            AND r.is_primary
          ORDER BY r.display_order, r.created_at
          LIMIT 1)            AS "responsibleEmailEnc",
        -- Nome do responsável primário (D249). Texto claro, sem KMS: a coluna
        -- não é cifrada. É o que a lista mostra quando o paciente ainda não tem
        -- nome — o lead "para otra persona" nasce assim.
        (SELECT NULLIF(btrim(concat_ws(' ', r.first_name, NULLIF(r.last_name, ''))), '')
           FROM patient_responsibles r
          WHERE r.patient_id = p.id
            AND r.is_primary
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
          OR EXISTS (
               SELECT 1 FROM patient_responsibles r
                WHERE r.patient_id = p.id
                  AND (r.first_name ILIKE '%' || $${searchIdx} || '%'
                    OR r.last_name  ILIKE '%' || $${searchIdx} || '%')))
        AND ($${needsAttentionIdx}::boolean IS NULL OR p.needs_attention = $${needsAttentionIdx})
        AND ($${attentionReasonIdx}::text IS NULL OR $${attentionReasonIdx} = ANY(p.attention_reasons))
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
        needsAttention: row.needsAttention,
        attentionReasons: row.attentionReasons ?? [],
        addressesCount: parseInt(row.addressesCount as unknown as string, 10) || 0,
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

    await this.attachLeadContact(rows, result.rows);

    return { rows, total };
  }

  /**
   * Segunda passada da listagem: desempata os cards que só dizem "Solicitante".
   *
   * O formulário público não colhe nome (`2026-07-27a#DEC-02`), então todo lead
   * chega com o mesmo placeholder e o Kanban vira N caixas idênticas. Aqui o
   * contato entra MASCARADO para desempatá-las — sob as condições do parecer
   * do lex de 30/08:
   *
   *  C2 — o corte é no servidor: só linha com placeholder é tocada. Ficha com
   *       nome real sai com `null`, e o ciphertext dela nunca vira texto.
   *  C4 — por consequência, o nº de chamadas ao KMS é EXATAMENTE o nº de linhas
   *       com placeholder — e ZERO numa página sem nenhuma. Este caminho de
   *       listagem não chamava o KMS antes; a conta é o controle positivo.
   *  C1 — a máscara é aplicada aqui, não no React: o valor cru não entra no
   *       payload, no devtools nem na gravação de sessão.
   *  C6 — nos leads preenchidos pelo familiar o paciente não tem e-mail
   *       (CreateLeadUseCase grava o contato no responsável); marcamos de quem
   *       é, para o card não atribuir contato de terceiro ao paciente.
   *
   * Falha de descriptografia não derruba a listagem: o card volta ao estado
   * anterior (só "Solicitante"), que é degradação, não perda de dado.
   */
  private async attachLeadContact(
    rows: PatientListRow[],
    raw: Array<Record<string, unknown>>,
  ): Promise<void> {
    const pending = rows
      .map((row, idx) => ({ row, raw: raw[idx] }))
      .filter(({ row }) => isLeadPlaceholderName(row.firstName, row.lastName));

    if (pending.length === 0) return;

    // Contadores para o sinal do fim: sem eles, dado que deriva de forma faz TODOS
    // os cards perderem o contato em silêncio absoluto (blocker do gate, 31/08).
    let recusados = 0;
    let falhas = 0;
    // Sem esta 3ª coluna, um rename do alias do SQL zera TODOS os cards com
    // recusados=0 e falhas=0 — silêncio absoluto (aviso 1 do gate, 31/08).
    let semCifra = 0;

    // Lotes de DECRYPT_BATCH: `Promise.all` sobre a página inteira dispararia até
    // 500 chamadas simultâneas ao KMS (teto do adminPatientsListSchema). O padrão
    // e o número vêm de AdminWorkersMapController.ts:51, que já resolve isso.
    for (let inicio = 0; inicio < pending.length; inicio += DECRYPT_BATCH) {
    await Promise.all(
      pending.slice(inicio, inicio + DECRYPT_BATCH).map(async ({ row, raw: r }) => {
        // O e-mail do paciente manda; o do responsável é o fallback dos leads
        // preenchidos pelo familiar. Só UM dos dois é descriptografado.
        const own = (r.contactEmailEnc as string | null) ?? null;
        const responsible = (r.responsibleEmailEnc as string | null) ?? null;
        const cipher = own ?? responsible;
        if (cipher == null) { semCifra += 1; return; }

        try {
          const plain = await this.encryptionService.decrypt(cipher);
          const masked = maskEmail(plain);
          if (masked == null) { recusados += 1; return; }
          row.leadContactEmailMasked = masked;
          row.leadContactIsResponsible = own == null;
        } catch {
          // Degrada o card, não a listagem — mas CONTA (ver o warn abaixo).
          falhas += 1;
        }
      }),
    );
    }

    // O que era silêncio absoluto vira sinal. Só CONTAGEM: a regra dura proíbe
    // PII em log e permite contar (o V5 do gate afirma exatamente isso).
    if (recusados > 0 || falhas > 0 || semCifra > 0) {
      logger.warn({
        msg: 'patient_lead_contact.degraded',
        pendentes: pending.length,
        recusadosPelaMascara: recusados,
        falhasDeKms: falhas,
        semCifra,
      });
    }
  }

  async stats(country?: 'AR' | 'BR'): Promise<PatientStatsRow> {
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
        COUNT(*) FILTER (WHERE needs_attention = false)::int                         AS complete,
        COUNT(*) FILTER (WHERE needs_attention = true)::int                          AS needs_attention,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int          AS created_today,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('day', NOW() - INTERVAL '1 day')
            AND created_at <  date_trunc('day', NOW())
        )::int                                                                       AS created_yesterday,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int        AS created_last_7_days
      FROM patients
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR country = $1)
    `, [country ?? null]);

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
  async findDetailById(id: string): Promise<PatientDetailRow | null> {
    return fetchPatientDetail(this.pool, this.encryptionService, id);
  }
}
