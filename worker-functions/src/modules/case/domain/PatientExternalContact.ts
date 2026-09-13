/**
 * Contato de terceiro SEM vínculo familiar na "rede de apoio" do paciente (migration 422; spec 018
 * PR-2, US-12, `lex` #4): professor, diretor/funcionário de escola, vizinho, empregador, gestor de
 * caso da obra social, referente comunitário. NÃO é responsável (`patient_responsibles`) nem
 * contato de emergência da COBERTURA MÉDICA (`patient_coverage_emergency_contacts`).
 *
 * SEM categoria de saúde no enum de `relation` (condição do lex), SEM documento (D-A #6), SEM
 * texto livre. Telefone é PII cifrada via KMS, opcional (sem telefone não pode ser marcado de
 * emergência — D-A #3). Escrita por LINHA (spec 018, ADR-1): troca de contato = desativar + criar
 * (REGRA-08, D94) — nunca DELETE pela aplicação.
 */
export const EXTERNAL_CONTACT_RELATIONS = [
  'TEACHER',
  'SCHOOL_DIRECTOR',
  'SCHOOL_STAFF',
  'NEIGHBOR',
  'EMPLOYER',
  'INSURANCE_CASE_MANAGER',
  'COMMUNITY_REFERENT',
  'OTHER',
] as const;
export type ExternalContactRelation = (typeof EXTERNAL_CONTACT_RELATIONS)[number];

export const EXTERNAL_CONTACT_NAME_MAX = 200;
export const EXTERNAL_CONTACT_PHONE_MAX = 40;

/** O que a rota de criação recebe. */
export interface PatientExternalContactInput {
  relation: ExternalContactRelation;
  name: string;
  phone?: string | null;
}

/** O que a ficha lê (telefone já decifrado — só quando o ator tem `patient_family:read`). */
export interface PatientExternalContactDetail {
  id: string;
  relation: ExternalContactRelation;
  name: string;
  phone: string | null;
  active: true; // a ficha só projeta linhas ativas (FR-004, mesmo padrão dos responsáveis)
}

/**
 * PATCH parcial de uma linha — escrita por linha (spec 018 PR-2, ADR-1). RFC 7396: chave ausente
 * não toca a coluna. `relation`/`name` não aceitam `null` (colunas NOT NULL); `phone` aceita
 * `null` para apagar (bloqueado pelo trigger da 423 se a linha estiver marcada de emergência).
 */
export interface PatientExternalContactPatch {
  relation?: ExternalContactRelation;
  name?: string;
  phone?: string | null;
}
