import { inPatientTransaction } from './patientTransaction';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { PatientClinicalRepository } from '../infrastructure/PatientClinicalRepository';
import { PatientResponsibleRepository } from '../infrastructure/PatientResponsibleRepository';
import { PatientDeviceTypeRepository } from '../infrastructure/PatientDeviceTypeRepository';
import { PatientInsuranceVerifiedRepository } from '../infrastructure/PatientInsuranceVerifiedRepository';
import type { PatientRelatedInput, PatientServiceUpsertInput } from './PatientWriteInputs';

/**
 * PatientSectionWriter — a EDIÇÃO POR SEÇÃO da ficha (os drawers do painel), e só ela.
 *
 * Extraído de `PatientService` para manter aquele arquivo dentro do teto de 400 linhas — mesmo
 * motivo e mesmo molde de `PatientRelatedWriter`. Nada de comportamento mudou de lugar: mesma
 * transação única, mesmo `switch` por seção, mesma whitelist de colunas do update parcial,
 * mesma guarda por `EXISTS` do `service_type`.
 *
 * `PatientService.updatePatientSection` continua sendo a porta (é ela que o controller
 * conhece) e é ela que monta as dependências abaixo.
 */

/**
 * O que a escrita por seção precisa do serviço. Os dois últimos são THUNKS de propósito: o
 * repositório de dispositivo e o de cobertura são PREGUIÇOSOS em `PatientService` (construir o
 * de cobertura abre pool, e as suítes que dublam o banco não precisam saber deles). Recebê-los
 * já construídos aqui destruiria essa preguiça.
 */
export interface PatientSectionWriterDeps {
  clinicalRepo: PatientClinicalRepository;
  responsibleRepo: PatientResponsibleRepository;
  encryptionService: KMSEncryptionService;
  deviceTypeRepo: () => PatientDeviceTypeRepository;
  insuranceRepo: () => PatientInsuranceVerifiedRepository;
}

/** Section-scoped partial update of a native (or any) patient. */
export type PatientSection = 'general' | 'clinical' | 'coverage' | 'support-network' | 'service';

/** section = 'clinical' (spec 012, US-B4): o bloco clínico + os CÓDIGOS de dispositivo do catálogo. */
export type PatientClinicalSectionData = PatientRelatedInput & { deviceTypes?: string[] };

/** section = 'coverage' (spec 012, US-B3): cobertura informada, nº de afiliado, verificadas por código. */
export interface PatientCoverageSectionData {
  healthInsuranceName?: string | null;
  affiliateId?: string | null;
  insuranceVerifiedCodes?: string[];
}

/** Identity fields updatable via the 'general' section. */
export interface PatientGeneralSectionData {
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: Date | null;
  documentType?: PatientServiceUpsertInput['documentType'];
  documentNumber?: string | null;
  affiliateId?: string | null;
  sex?: PatientServiceUpsertInput['sex'];
  phoneWhatsapp?: string | null;
  healthInsuranceName?: string | null;
  healthInsuranceMemberId?: string | null;
  /** Plaintext; encrypted with KMS before storage. */
  contactEmail?: string | null;
  /** US-B9 (spec 012): data de início do serviço — nativa, não deriva da vaga. */
  serviceStartDate?: Date | null;
}

/**
 * Partial, section-scoped update of a patient (native or ClickUp-origin).
 *   - general:         identity fields (name, doc, phone, contact email…)
 *   - clinical:        the full PatientClinical block (reuses clinicalRepo)
 *   - support-network: responsibles (replaceAll — a lista inteira, é a intenção da tela)
 *   - service:         just service_type (targeted UPDATE — does NOT clobber
 *                      the rest of the clinical block)
 * Does NOT touch `origin`. Runs in a single transaction.
 */
export async function writePatientSection(
  deps: PatientSectionWriterDeps,
  patientId: string,
  section: PatientSection,
  data: PatientGeneralSectionData | PatientClinicalSectionData | PatientCoverageSectionData | PatientRelatedInput,
  /** Quem está editando (uid do staff) — hoje só a seção clínica usa (autoria de additional_comments). */
  actor?: { uid: string; cells?: readonly string[] | null },
): Promise<{ id: string; updated: true }> {
  return inPatientTransaction(async (client) => {
    switch (section) {
      case 'general':
        await updateGeneralSection(deps, patientId, data as PatientGeneralSectionData, client);
        break;
      case 'clinical': {
        const c = data as PatientClinicalSectionData;
        await deps.clinicalRepo.upsert(
          {
            patientId,
            diagnosis:             c.diagnosis,
            dependencyLevel:       c.dependencyLevel,
            clinicalSpecialty:     c.clinicalSpecialty,
            clinicalSegments:      c.clinicalSegments,
            serviceType:           c.serviceType,
            additionalComments:    c.additionalComments,
            emergencyInstructions: c.emergencyInstructions,
            hasJudicialProtection: c.hasJudicialProtection,
            hasCud:                c.hasCud,
            hasConsent:            c.hasConsent,
            actorUid:              actor?.uid ?? null,
          },
          client,
        );
        // US-B4: dispositivo é CONJUNTO de códigos do catálogo; o escalar é o trigger da 310.
        if (c.deviceTypes !== undefined) {
          await deps.deviceTypeRepo().replaceCodesForPatient(patientId, c.deviceTypes, client);
        }
        break;
      }
      case 'coverage': {
        // US-B3: os dois escalares vão pelo MESMO update parcial do geral (mesma whitelist);
        // as verificadas por código vão para patient_insurance_verified (source='admin_manual').
        const cov = data as PatientCoverageSectionData;
        const scalars: PatientGeneralSectionData = {};
        if (Object.prototype.hasOwnProperty.call(cov, 'healthInsuranceName')) scalars.healthInsuranceName = cov.healthInsuranceName;
        if (Object.prototype.hasOwnProperty.call(cov, 'affiliateId')) scalars.affiliateId = cov.affiliateId;
        await updateGeneralSection(deps, patientId, scalars, client);
        if (cov.insuranceVerifiedCodes !== undefined) {
          await deps.insuranceRepo().replaceCodesForPatient(patientId, cov.insuranceVerifiedCodes, client);
        }
        // Os contatos de emergência da cobertura SAÍRAM desta seção (spec 018, PR-1, ADR-1,
        // SUP-37): a escrita é por LINHA, em rotas próprias
        // (`AdminPatientContactRowsController`), não mais aqui. `emergencyContacts` nem chega —
        // o schema `.strict()` de `coverage` já recusa o campo com 400.
        break;
      }
      case 'support-network': {
        const responsibles = (data as PatientRelatedInput).responsibles ?? [];
        await deps.responsibleRepo.replaceAll(patientId, responsibles, client);
        break;
      }
      case 'service': {
        // Targeted: only service_type. (Desde a D211.1 o clinicalRepo.upsert é
        // parcial — chave ausente não toca a coluna — mas este caminho
        // continua direto: uma coluna, uma query.)
        //
        // FR-C1 (spec 013, migration 321): "nunca escrito à mão pelos drawers" é
        // INCONDICIONAL — não só quando o serviço já existe. Este caminho é o segundo
        // escritor de service_type[] (o primeiro é PatientClinicalRepository.upsert, o
        // espelho ClickUp) e precisa da MESMA guarda por EXISTS, ou reabre a classe de bug
        // da migration 310/F64 por uma porta que o guard de lá não cobre. O drawer novo do
        // bloco C não chama mais esta rota (ver ServicosContratadosCard) — a guarda é
        // cinto de segurança para quem ainda chamar.
        const serviceType = (data as PatientRelatedInput).serviceType;
        const value =
          serviceType !== undefined && serviceType !== null && serviceType.length > 0
            ? serviceType
            : null;
        await client.query(
          `UPDATE patients SET service_type = CASE WHEN EXISTS (
             SELECT 1 FROM patient_contracted_services pcs
              WHERE pcs.patient_id = patients.id AND pcs.active
           ) THEN patients.service_type ELSE $2 END, updated_at = NOW() WHERE id = $1`,
          [patientId, value],
        );
        break;
      }
    }

    return { id: patientId, updated: true as const };
  });
}

async function updateGeneralSection(
  deps: PatientSectionWriterDeps,
  patientId: string,
  data: PatientGeneralSectionData,
  client: import('pg').PoolClient,
): Promise<void> {
  // Column whitelist — partial update: only columns present in `data` are set.
  const columnByKey: Record<string, string> = {
    firstName:               'first_name',
    lastName:                'last_name',
    birthDate:               'birth_date',
    documentType:            'document_type',
    documentNumber:          'document_number',
    affiliateId:             'affiliate_id',
    sex:                     'sex',
    phoneWhatsapp:           'phone_whatsapp',
    healthInsuranceName:     'health_insurance_name',
    healthInsuranceMemberId: 'health_insurance_member_id',
    serviceStartDate:        'service_start_date',
  };

  const sets: string[] = [];
  const values: unknown[] = [patientId];

  for (const [key, column] of Object.entries(columnByKey)) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      values.push((data as Record<string, unknown>)[key] ?? null);
      sets.push(`${column} = $${values.length}`);
    }
  }

  // Contact email is encrypted (KMS) before storage, like the responsibles.
  if (Object.prototype.hasOwnProperty.call(data, 'contactEmail')) {
    const enc = await deps.encryptionService.encrypt(data.contactEmail ?? null);
    values.push(enc);
    sets.push(`contact_email_encrypted = $${values.length}`);
  }

  if (sets.length === 0) return; // nothing to update

  sets.push('updated_at = NOW()');
  await client.query(
    `UPDATE patients SET ${sets.join(', ')} WHERE id = $1`,
    values,
  );
}
