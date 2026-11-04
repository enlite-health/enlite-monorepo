/** Entrevistador de enquadre e/ou admissão (spec 055) — uma linha da tela Entrevistadores. */
export type InterviewHostCountry = 'AR' | 'BR';

export const INTERVIEW_HOST_COUNTRIES: readonly InterviewHostCountry[] = ['AR', 'BR'];

/** Estado do vínculo com o Tactiq; a tela só distingue `linked` do resto (o vínculo é ato da própria pessoa). */
export type InterviewHostTactiqState = 'missing' | 'linked' | 'broken' | 'wrong_account' | 'revoked';

export interface InterviewHost {
  id: string;
  email: string;
  displayName: string | null;
  countries: InterviewHostCountry[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
  userUid: string | null;
  /** Sem usuário no sistema: fora do roster de agendamento; a tela só oferece "Quitar". */
  userMissing: boolean;
  /** O usuário existe mas foi desativado: sai dos dois fluxos sozinho. */
  userInactive: boolean;
  tactiq: InterviewHostTactiqState;
}

/** Usuário staff ativo que pode virar entrevistador. */
export interface InterviewHostCandidate {
  uid: string;
  displayName: string | null;
  email: string;
}

export interface InterviewHostInput {
  countries: InterviewHostCountry[];
  doesEnquadre: boolean;
  doesAdmission: boolean;
}
