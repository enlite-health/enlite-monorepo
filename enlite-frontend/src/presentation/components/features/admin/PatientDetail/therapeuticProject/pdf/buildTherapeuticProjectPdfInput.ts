/**
 * Monta o insumo do PDF a partir do que a TELA já tem (lex C12): a ficha projetada pelo backend e a
 * versão buscada A CADA clique (`purpose=export`, trilha C13). A decisão "esta seção entra?" é a
 * MESMA dos cards — a célula do container (`reads`), lida pelo chamador com `useContainerAccess`.
 * Rótulos em es-AR fixos: o PDF não segue o idioma do painel (D299.7).
 */
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { ResolvedTherapeuticContact, TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { contractedServiceScheduleText } from '../../contractedServiceScheduleText';
import { ageFromBirthDate, type PdfContact, type PdfCoverageContact, type TherapeuticProjectPdfInput } from './therapeuticProjectPdfInput';

export interface PdfContainerReads {
  identity: boolean;
  coverage: boolean;
  address: boolean;
  family: boolean;
  careTeam: boolean;
  services: boolean;
}

/** Tradutor fixo em espanhol (`i18n.getFixedT('es')`) — o PDF é es-AR sempre. */
export type EsTranslate = (key: string, fallback?: string) => string;

const SERVICE_KEY = 'admin.patients.detail.contractedServicesCard.serviceTypes';
const DEVICE_KEY = 'admin.patients.deviceTypeOptions';
const CARE_LOCATION_KEY = 'admin.patients.detail.contractedServicesCard.careLocationOptions';
const RELATIONSHIP_KEY = 'admin.patients.detail.relationshipOptions';
const EXTERNAL_RELATION_KEY = 'admin.patients.detail.externalContactRelationOptions';
const DOCUMENT_KEY = 'admin.patients.detail.documentTypes';
const MODALITY_KEY = 'admin.patients.detail.therapeuticProjectCard.modalityOptions';
const COVERAGE_CONTACT_KIND_KEY = 'admin.patients.detail.coverageCard.emergencyContactKinds';

/**
 * Rótulo do vínculo de um contato RESOLVIDO (nunca inativo/redigido — só chega aqui quem tem
 * `name`). RESPONSIBLE/EXTERNAL traduzem `relation` por catálogo próprio; CARE_TEAM usa a
 * especialidade (texto livre, sem catálogo); COVERAGE tem rótulo próprio (`PdfCoverageContact`).
 */
function contactRelationshipLabel(c: Extract<ResolvedTherapeuticContact, { name: string }>, tEs: EsTranslate): string | null {
  if (c.kind === 'RESPONSIBLE') return c.relation ? tEs(`${RELATIONSHIP_KEY}.${c.relation}`, c.relation) : null;
  if (c.kind === 'EXTERNAL') return c.relation ? tEs(`${EXTERNAL_RELATION_KEY}.${c.relation}`, c.relation) : null;
  // CARE_TEAM (o único `kind` que sobra aqui — COVERAGE vai por `toPdfCoverageContact`, nunca por esta função).
  return c.specialty ?? null;
}

/**
 * Contato SELECIONADO na versão (`version.contacts`, PR-7) → forma do PDF (lex #7 C5): inativo
 * NUNCA resolve nome/telefone ("contacto dado de baja"); sem célula de origem → "omitido por
 * permiso" (C12). Resolvido: nome/telefone/vínculo, todos JÁ traduzidos pelo backend em `kind`.
 */
function toPdfContact(c: ResolvedTherapeuticContact, tEs: EsTranslate): PdfContact {
  if ('inactive' in c) return { status: 'inactive' };
  if ('redacted' in c) return { status: 'redacted' };
  return { status: 'resolved', name: c.name, relationship: contactRelationshipLabel(c, tEs), phone: c.phone };
}

/** Mesma régua de `toPdfContact`, forma do bloco de cobertura (kind traduzido, telefone obrigatório na origem). */
function toPdfCoverageContact(c: ResolvedTherapeuticContact, tEs: EsTranslate): PdfCoverageContact {
  if ('inactive' in c) return { status: 'inactive' };
  if ('redacted' in c) return { status: 'redacted' };
  const kind = c.relation ?? '';
  return { status: 'resolved', kindLabel: tEs(`${COVERAGE_CONTACT_KIND_KEY}.${kind}`, kind), name: c.name, phone: c.phone ?? '' };
}

export function buildTherapeuticProjectPdfInput(args: {
  patient: PatientDetail;
  version: TherapeuticProjectVersion;
  reads: PdfContainerReads;
  tEs: EsTranslate;
  now?: Date;
  logoSrc?: string;
}): TherapeuticProjectPdfInput {
  const { patient, version, reads, tEs, logoSrc } = args;
  const now = args.now ?? new Date();

  const service: PatientContractedServiceDetail | null = reads.services
    ? patient.contractedServices.find((s) => s.id === version.contractedServiceId) ?? null
    : null;
  const address = service?.addressId ? patient.addresses.find((a) => a.id === service.addressId) ?? null : null;

  const identification = reads.identity
    ? {
        fullName: [patient.firstName, patient.lastName].filter(Boolean).join(' ') || '—',
        documentLabel: patient.documentNumber
          ? `${patient.documentType ? tEs(`${DOCUMENT_KEY}.${patient.documentType}`, patient.documentType) : ''} ${patient.documentNumber}`.trim()
          : '—',
        birthDate: patient.birthDate,
        age: ageFromBirthDate(patient.birthDate, now),
      }
    : null;

  const coverage = reads.coverage
    ? { insurance: patient.insuranceInformed ?? patient.insuranceVerified ?? null, affiliateId: patient.affiliateId }
    : null;

  const pdfService = reads.services
    ? service
      ? {
          serviceLabel: tEs(`${SERVICE_KEY}.${service.serviceCode}`, service.serviceCode),
          deviceLabels: service.deviceTypes.map((d) => tEs(`${DEVICE_KEY}.${d}`, d)),
          providerProfile: service.professionalProfile,
          scheduleText: contractedServiceScheduleText(service.schedule),
          careLocationLabel: service.careLocation ? tEs(`${CARE_LOCATION_KEY}.${service.careLocation}`, service.careLocation) : null,
        }
      : { serviceLabel: '—', deviceLabels: [], providerProfile: null, scheduleText: null, careLocationLabel: null }
    : null;

  // Endereço: o do SERVIÇO escolhido; sem vínculo, o principal do paciente. Sem célula de endereço, omitido.
  const addressText = reads.address
    ? address
      ? `${patientAddressLabel(address)}${address.complement ? `, ${address.complement}` : ''}`
      : (() => {
          const principal = patient.addresses.find((a) => a.isPrimary) ?? patient.addresses[0];
          return principal ? `${patientAddressLabel(principal)}${principal.complement ? `, ${principal.complement}` : ''}` : '—';
        })()
    : null;

  // PR-7 (lex #7 C5/C12): os contatos vêm SEMPRE de `version.contacts` — SELECIONADOS na versão e já
  // RESOLVIDOS pelo backend pela célula de origem (nunca dos containers crus do paciente; isso
  // deixaria passar contato que não foi escolhido, ou vazaria nome/telefone de linha inativa).
  // RESPONSIBLE + EXTERNAL compõem o mesmo bloco "familiar/persona responsable" (mesmo container `family`).
  const emergencyContacts = reads.family
    ? version.contacts.filter((c) => c.kind === 'RESPONSIBLE' || c.kind === 'EXTERNAL').map((c) => toPdfContact(c, tEs))
    : null;

  // D301.3b / lex C5: bloco PRÓPRIO sob a célula de COBERTURA — nunca somado ao dos familiares. O profissional
  // direto já vem filtrado pelo servidor (só com equipe também, C3) — e o servidor DIZ que filtrou
  // (`coverageDirectProfessionalRedacted`); "campo ausente" (backend anterior à 417) e "leitura falhou"
  // viram `unavailable`, nunca `[]` (D167: não-li ≠ vazio) — flags do container, independentes da seleção.
  const contactsMissing = patient.coverageEmergencyContacts === undefined || patient.coverageEmergencyContactsUnavailable === true;
  const coverageEmergencyContacts = reads.coverage
    ? version.contacts.filter((c) => c.kind === 'COVERAGE').map((c) => toPdfCoverageContact(c, tEs))
    : null;

  const careTeam = reads.careTeam ? version.contacts.filter((c) => c.kind === 'CARE_TEAM').map((c) => toPdfContact(c, tEs)) : null;

  return {
    // A ficha não carrega nº de caso (é da vaga); o id do paciente é a referência estável do rodapé (C14).
    caseRef: patient.id,
    version,
    identification,
    coverage,
    service: pdfService,
    addressText,
    emergencyContacts,
    coverageEmergencyContacts,
    coverageDirectProfessionalRedacted: reads.coverage && patient.coverageDirectProfessionalRedacted === true,
    coverageEmergencyContactsUnavailable: reads.coverage && contactsMissing,
    fixedSectionsServiceCode: version.contractedServiceCode,
    modalityLabel: version.modality ? tEs(`${MODALITY_KEY}.${version.modality}`, version.modality) : null,
    careTeam,
    issuedAtText: formatIssuedAt(now),
    logoSrc,
  };
}

/** `dd/mm/aaaa HH:MM` — local do operador, sem depender de Intl (determinístico em teste). */
export function formatIssuedAt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
