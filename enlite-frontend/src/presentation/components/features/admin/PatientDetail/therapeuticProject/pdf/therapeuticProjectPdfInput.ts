/**
 * O que o PDF do projeto terapêutico recebe — JÁ projetado por célula e JÁ rotulado (spec 017;
 * lex C12: o PDF consome só o que a tela recebeu; seção de container redigido sai omitida com
 * rótulo). O template não consulta API, i18n nem store: recebe strings e `null`.
 *
 * `null` em um bloco = "o ator não tem a célula desse container" → seção omitida com rótulo.
 * `[]`/`'—'` = "tem a célula, e o dado está vazio".
 */
import type { TherapeuticProjectVersion } from '@domain/entities/TherapeuticProject';

export interface PdfIdentification {
  fullName: string;
  documentLabel: string;
  birthDate: string | null;
  age: number | null;
}

export interface PdfCoverage {
  insurance: string | null;
  affiliateId: string | null;
}

export interface PdfService {
  serviceLabel: string;
  deviceLabels: string[];
  providerProfile: string | null;
  scheduleText: string | null;
  careLocationLabel: string | null;
}

export interface PdfContact {
  name: string;
  relationship: string | null;
  phone: string | null;
  email: string | null;
}

/** Contato de emergência da COBERTURA (417; D301.3b) — rótulo do tipo já traduzido. */
export interface PdfCoverageContact {
  kindLabel: string;
  name: string;
  phone: string;
}

export interface TherapeuticProjectPdfInput {
  /** `caseNumber` do paciente ou, sem ele, o id — vai no rodapé de toda página (lex C14). */
  caseRef: string;
  version: TherapeuticProjectVersion;
  identification: PdfIdentification | null;
  coverage: PdfCoverage | null;
  service: PdfService | null;
  addressText: string | null;
  /** Familiar/persona responsable — sob `patient_family:read`. */
  emergencyContacts: PdfContact[] | null;
  /** Emergencia de la cobertura médica — bloco PRÓPRIO, sob `patient_coverage:read` (lex C5); nunca somado ao de cima. */
  coverageEmergencyContacts: PdfCoverageContact[] | null;
  /** lex C3: o profissional direto foi retido (sem `patient_care_team:read`) — o bloco acima diz isso, nunca finge completude. */
  coverageDirectProfessionalRedacted: boolean;
  /** Bulkhead (D167): a leitura dos contatos falhou — imprime "indisponível", nunca "—". */
  coverageEmergencyContactsUnavailable: boolean;
  /** `service_code` congelado NA VERSÃO (417): as seções fixas VIII/IX (texto constante) dependem só disto. */
  fixedSectionsServiceCode: string;
  /** Modalidade já traduzida; `null` = versão anterior à 417. */
  modalityLabel: string | null;
  careTeam: string[] | null;
  /** Data/hora de emissão, já formatada (es-AR). */
  issuedAtText: string;
  /** URL/dataURL do logo, servido da própria origem; opcional (o teste em Node não carrega imagem). */
  logoSrc?: string;
}

/** `dd/mm/aaaa` a partir de ISO `aaaa-mm-dd` (ou ISO completo) — sem fuso: a data é civil. */
export function formatIsoDateEsAr(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** "Septiembre a diciembre 2026" — o "Plazo de implementación" do documento, em espanhol. */
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function implementationPeriodText(startIso: string, endIso: string): string {
  const s = /^(\d{4})-(\d{2})/.exec(startIso);
  const e = /^(\d{4})-(\d{2})/.exec(endIso);
  if (!s || !e) return `${formatIsoDateEsAr(startIso)} – ${formatIsoDateEsAr(endIso)}`;
  const mesS = MESES_ES[Number(s[2]) - 1];
  const mesE = MESES_ES[Number(e[2]) - 1];
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  if (s[1] === e[1]) return `${cap(mesS)} a ${mesE} ${e[1]}`;
  return `${cap(mesS)} ${s[1]} a ${mesE} ${e[1]}`;
}

/** Idade civil a partir da data de nascimento ISO; `null` sem data ou data inválida. */
export function ageFromBirthDate(birthIso: string | null | undefined, today: Date = new Date()): number | null {
  if (!birthIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthIso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  let age = today.getFullYear() - y;
  if (today.getMonth() < mo || (today.getMonth() === mo && today.getDate() < d)) age -= 1;
  return age >= 0 ? age : null;
}
