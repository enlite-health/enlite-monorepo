/** Erros nomeados do repositório do Projeto Terapêutico (extraídos de `TherapeuticProjectRepository.ts`, limite de 400 linhas; sem mudança de regra). */

import type { TherapeuticMacroField } from '../domain/TherapeuticProject';

/** A versão de origem do "Editar" não existe neste paciente (ou está anulada). */
export class SourceVersionNotFoundError extends Error {
  readonly code = 'source_version_not_found';
  constructor() {
    super('source_version_not_found');
  }
}

/**
 * `mode:'edit'` com `fromVersionId` que NÃO é a vigente (ADR-4/SUP-24; lex-pr7 contract §alterado):
 * 409, nunca 422 — o corpo pode estar perfeito, o problema é a versão-alvo ter ficado velha
 * (outra edição/anulação aconteceu entre o GET e o POST). Backend é a fonte da verdade (R4): a
 * tela trava o campo, mas a API tem de recusar mesmo se alguém escrever direto.
 */
export class VersionNotCurrentError extends Error {
  readonly code = 'ptp_not_current';
  constructor() {
    super('ptp_not_current');
  }
}

/**
 * `mode:'edit'` mudando campo MACRO (lex-pr7 contract §alterado, ADR-4/D328): 422 com só os
 * NOMES dos campos — nunca o valor enviado (lex #7 C7: erro não ecoa texto clínico).
 */
export class MacroFieldsLockedError extends Error {
  readonly code = 'ptp_macro_locked';
  constructor(readonly fields: TherapeuticMacroField[]) {
    super('ptp_macro_locked');
  }
}

/** O paciente não existe (ou não é visível sob a RLS) — a trava `FOR UPDATE` não achou linha. */
export class PatientNotFoundForProjectError extends Error {
  readonly code = 'patient_not_found';
  constructor() {
    super('patient_not_found');
  }
}

/** O serviço contratado escolhido não é deste paciente (trigger `ptp_service_de_outro_paciente`, 416). */
export class ServiceNotOfPatientError extends Error {
  readonly code = 'service_not_of_patient';
  constructor() {
    super('service_not_of_patient');
  }
}

export const isServiceOfOtherPatient = (err: unknown): boolean =>
  /ptp_service_de_outro_paciente/.test(String((err as { message?: string })?.message ?? ''));

/**
 * `mode:'new'|'edit'` com `contactRefs`/`careTeamIds` apontando para contato INATIVO ou de outro
 * paciente (trigger `fn_patient_therapeutic_project_contacts_imutavel`, 429): 422, só `kind`/`id`
 * — nunca nome/telefone (lex #7 C7). FK violada (23503, o par id/patient_id não existe) vira 404.
 */
export class ContactInactiveError extends Error {
  readonly code = 'ptp_contact_inactive';
  constructor(readonly kind: string, readonly id: string) {
    super('ptp_contact_inactive');
  }
}

/** O `id` referenciado não é uma linha ATIVA deste paciente (FK 23503 das 4 constraints da 429). */
export class ContactNotFoundError extends Error {
  readonly code = 'contact_not_found';
  constructor(readonly kind: string, readonly id: string) {
    super('contact_not_found');
  }
}

export const isContactInactiveViolation = (err: unknown): boolean =>
  (err as { code?: string })?.code === '22023' && /ptp_contact_inactive/.test(String((err as { message?: string })?.message ?? ''));

export const isForeignKeyViolation = (err: unknown): boolean => (err as { code?: string })?.code === '23503';


/**
 * spec 048: "No necesita" NOVO sem `patient_therapeutic_project:waive_contact` — 403, com só os NOMES dos campos.
 * A checagem mora no repositório porque precisa da vigente (NOT_NEEDED herdado passa), lida com o paciente travado.
 */
export class WaiveContactForbiddenError extends Error {
  readonly code = 'ptp_waive_contact_forbidden';
  constructor(readonly fields: string[]) {
    super('ptp_waive_contact_forbidden');
  }
}
