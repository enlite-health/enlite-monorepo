export type RejectionReasonCategory =
  | 'DISTANCE'
  | 'SCHEDULE_INCOMPATIBLE'
  | 'INSUFFICIENT_EXPERIENCE'
  | 'SALARY_EXPECTATION'
  | 'WORKER_DECLINED'
  | 'OVERQUALIFIED'
  | 'DEPENDENCY_MISMATCH'
  | 'TALENTUM_NOT_QUALIFIED'
  | 'OTHER';

export type EncuadreResultado =
  | 'SELECCIONADO'
  | 'RECHAZADO'
  | 'AT_NO_ACEPTA'
  | 'REPROGRAMAR'
  | 'REEMPLAZO'
  | 'BLACKLIST'
  | 'PENDIENTE';

/**
 * Papel do encuadre selecionado (migration 142, CHECK 'TITULAR'|'RAPID_RESPONSE').
 * TITULAR = titular do caso; RAPID_RESPONSE = substituto/backup. Base da métrica
 * "Equipe Armada" — ver domain/armedCases.ts.
 */
export type EncuadreRole = 'TITULAR' | 'RAPID_RESPONSE';

export interface Encuadre {
  id: string;
  workerId: string | null;
  jobPostingId: string | null;
  workerRawName: string | null;
  workerRawPhone: string | null;
  occupationRaw: string | null;
  recruiterName: string | null;
  coordinatorName: string | null;
  recruitmentDate: Date | null;
  interviewDate: Date | null;
  interviewTime: string | null;
  meetLink: string | null;
  attended: boolean | null;
  absenceReason: string | null;
  acceptsCase: 'Si' | 'No' | 'A confirmar' | null;
  rejectionReason: string | null;
  rejectionReasonCategory: RejectionReasonCategory | null;
  resultado: EncuadreResultado | null;
  role: EncuadreRole | null;
  redireccionamiento: string | null;
  hasCv: boolean | null;
  hasDni: boolean | null;
  hasCertAt: boolean | null;
  hasAfip: boolean | null;
  hasCbu: boolean | null;
  hasAp: boolean | null;
  hasSeguros: boolean | null;
  workerEmail: string | null;
  obsReclutamiento: string | null;
  obsEncuadre: string | null;
  obsAdicionales: string | null;
  // Campos suplementares — presentes nas abas individuais por caso, ausentes no _Base1
  // F8 (ADR-002): renomeado de 'origen'. Auditoria de import histórico apenas — SSOT real é wja.source.
  importSourceAudit: string | null;
  idOnboarding: string | null;
  dedupHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEncuadreDTO {
  workerId?: string | null;
  jobPostingId?: string | null;
  workerRawName?: string | null;
  workerRawPhone?: string | null;
  occupationRaw?: string | null;
  recruiterName?: string | null;
  coordinatorName?: string | null;
  recruitmentDate?: Date | null;
  interviewDate?: Date | null;
  interviewTime?: string | null;
  meetLink?: string | null;
  attended?: boolean | null;
  absenceReason?: string | null;
  acceptsCase?: 'Si' | 'No' | 'A confirmar' | null;
  rejectionReason?: string | null;
  rejectionReasonCategory?: RejectionReasonCategory | null;
  resultado?: EncuadreResultado | null;
  role?: EncuadreRole | null;
  redireccionamiento?: string | null;
  hasCv?: boolean | null;
  hasDni?: boolean | null;
  hasCertAt?: boolean | null;
  hasAfip?: boolean | null;
  hasCbu?: boolean | null;
  hasAp?: boolean | null;
  hasSeguros?: boolean | null;
  workerEmail?: string | null;
  obsReclutamiento?: string | null;
  obsEncuadre?: string | null;
  obsAdicionales?: string | null;
  importSourceAudit?: string | null;
  idOnboarding?: string | null;
  dedupHash: string;
}

/** Campos suplementares vindos das abas individuais por caso */
export interface SupplementEncuadreDTO {
  interviewTime?: string | null;
  meetLink?: string | null;
  importSourceAudit?: string | null;
  idOnboarding?: string | null;
  resultado?: EncuadreResultado | null;
  role?: EncuadreRole | null;
  hasCv?: boolean | null;
  hasDni?: boolean | null;
  hasCertAt?: boolean | null;
  hasAfip?: boolean | null;
  hasCbu?: boolean | null;
  hasAp?: boolean | null;
  hasSeguros?: boolean | null;
  workerEmail?: string | null;
  obsEncuadre?: string | null;
  obsAdicionales?: string | null;
  absenceReason?: string | null;
  rejectionReason?: string | null;
  rejectionReasonCategory?: RejectionReasonCategory | null;
  redireccionamiento?: string | null;
}

export interface EncuadreFilters {
  workerId?: string;
  jobPostingId?: string;
  resultado?: EncuadreResultado;
  recruitmentDateFrom?: Date;
  recruitmentDateTo?: Date;
}
