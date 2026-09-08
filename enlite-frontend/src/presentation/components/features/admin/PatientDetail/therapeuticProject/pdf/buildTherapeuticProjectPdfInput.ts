/**
 * Monta o insumo do PDF a partir do que a TELA já tem (lex C12): a ficha projetada pelo backend e a
 * versão buscada A CADA clique (`purpose=export`, trilha C13). A decisão "esta seção entra?" é a
 * MESMA dos cards — a célula do container (`reads`), lida pelo chamador com `useContainerAccess`.
 * Rótulos em es-AR fixos: o PDF não segue o idioma do painel (D299.7).
 */
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { contractedServiceScheduleText } from '../../contractedServiceScheduleText';
import { ageFromBirthDate, type TherapeuticProjectPdfInput } from './therapeuticProjectPdfInput';

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
const DOCUMENT_KEY = 'admin.patients.detail.documentTypes';
const MODALITY_KEY = 'admin.patients.detail.therapeuticProjectCard.modalityOptions';
const COVERAGE_CONTACT_KIND_KEY = 'admin.patients.detail.coverageCard.emergencyContactKinds';

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

  const emergencyContacts = reads.family
    ? patient.responsibles.map((r) => ({
        name: [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
        relationship: r.relationship ? tEs(`${RELATIONSHIP_KEY}.${r.relationship}`, r.relationship) : null,
        phone: r.phone,
        email: r.email,
      }))
    : null;

  // D301.3b / lex C5: bloco PRÓPRIO sob a célula de COBERTURA — nunca somado ao dos familiares. O profissional
  // direto já vem filtrado pelo servidor (só com equipe também, C3) — e o servidor DIZ que filtrou
  // (`coverageDirectProfessionalRedacted`); "campo ausente" (backend anterior à 417) e "leitura falhou"
  // viram `unavailable`, nunca `[]` (D167: não-li ≠ vazio).
  const contactsMissing = patient.coverageEmergencyContacts === undefined || patient.coverageEmergencyContactsUnavailable === true;
  const coverageEmergencyContacts = reads.coverage
    ? (patient.coverageEmergencyContacts ?? []).map((c) => ({
        kindLabel: tEs(`${COVERAGE_CONTACT_KIND_KEY}.${c.kind}`, c.kind),
        name: c.name,
        phone: c.phone,
      }))
    : null;

  const careTeam = reads.careTeam ? patient.professionals.map((p) => p.name ?? '—') : null;

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
