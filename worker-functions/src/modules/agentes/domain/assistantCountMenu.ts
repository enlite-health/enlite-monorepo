/**
 * assistantCountMenu — DONO do cardápio de contagem da Maria (change 085, spec §3/§4, DD5).
 * `src/contracts/assistants/count-menu.json` é GERADO daqui (`scripts/generateCountMenu.ts`);
 * o teste falha se divergirem. Só dados e tipos: nenhum SQL de execução mora aqui (é dos leitores).
 *
 * Cada campo aponta o dono do conceito (spec §4); este módulo só lista rótulos, valores e atalhos.
 */
import {
  ADMISSION_FUNNEL_STATUSES,
  PATIENT_STATUSES,
  isAdmissionFunnelStatus,
} from '@modules/case/domain/enums/PatientStatus';
import { OPEN_JOB_STATUSES } from '@modules/matching/domain/openJobStatuses';
import { CANONICAL_PROVINCES } from '@shared/utils/argentinaLocationNormalizer';
import { UNRESOLVED_ZONE_LABEL } from '@shared/utils/zoneKey';

export type CountEntity = 'workers' | 'patients' | 'vacancies';
export const COUNT_ENTITIES: readonly CountEntity[] = ['workers', 'patients', 'vacancies'] as const;

export interface CountFieldDef {
  /** Nome do campo na ferramenta. */
  field: string;
  /** Rótulo em espanhol (o que o modelo diz à pessoa). */
  label_es: string;
  /** Enum fechado: valor fora daqui gera erro estruturado com esta lista. */
  values: readonly string[];
  /** Sinônimos es/pt que o modelo pode mapear para o campo. */
  synonyms: readonly string[];
  /** Atalho -> valores do enum que ele expande. */
  shortcuts?: Readonly<Record<string, readonly string[]>>;
}

export interface CountEntityDef {
  /** Célula exigida para contar a entidade. */
  cell: 'worker:read' | 'patient:read' | 'vacancy:read';
  /** Recorte padrão em espanhol, devolvido no `scope` da resposta. */
  scope_es: string;
  fields: Readonly<Record<string, CountFieldDef>>;
}

const BOOL = ['true', 'false'] as const;

/** Rótulo do bucket sem zona: o do dono (`resolveZoneKey`), para o agrupamento casar. */
const ZONE_VALUES: readonly string[] = [...CANONICAL_PROVINCES, UNRESOLVED_ZONE_LABEL];

/** `workers.status` — CHECK de migrations/096_refactor_worker_status.sql:51. */
const WORKER_REGISTRATION_VALUES = ['REGISTERED', 'INCOMPLETE_REGISTER', 'DISABLED'] as const;

/**
 * `patients.status` — CHECK de migrations/498_patients_status_alta.sql:6-12. O vocabulário do código
 * (PATIENT_STATUSES) não tem o legado tolerado DISCONTINUED, que o CHECK ainda aceita; `(sin etapa)` = status nulo.
 */
const PATIENT_STAGE_VALUES = [...PATIENT_STATUSES, 'DISCONTINUED', '(sin etapa)'] as const;

/**
 * `job_postings.status` — CHECK de migrations/483_job_postings_de_baja.sql:55-65 (os 9; o tipo
 * JobPostingStatus do código não tem DE_BAJA). As 4 primeiras são as "abertas" do dono (OPEN_JOB_STATUSES).
 */
const VACANCY_STATUS_VALUES = [
  ...OPEN_JOB_STATUSES,
  'ACTIVE',
  'ON_HOLD',
  'SUSPENDED',
  'CLOSED',
  'DE_BAJA',
] as const;

export const COUNT_MENU: Readonly<Record<CountEntity, CountEntityDef>> = {
  workers: {
    cell: 'worker:read',
    scope_es:
      'prestadores sin fusionar, sin cuentas de prueba, del país del usuario y sin dar de baja (DISABLED); si el filtro nombra DISABLED, se incluyen',
    fields: {
      registration: {
        field: 'registration',
        label_es: 'cadastro',
        values: WORKER_REGISTRATION_VALUES,
        synonyms: ['registro', 'cadastro', 'estado del registro'],
      },
      zone: {
        field: 'zone',
        label_es: 'zona',
        values: ZONE_VALUES,
        synonyms: ['provincia', 'província', 'región'],
      },
      has_phone: {
        field: 'has_phone',
        label_es: 'tiene teléfono',
        values: BOOL,
        synonyms: ['teléfono', 'celular', 'telefone'],
      },
      apto: {
        field: 'apto',
        label_es: 'apto (cadastro completo + documentos obligatorios validados)',
        values: BOOL,
        synonyms: ['apta', 'habilitado', 'habilitada'],
      },
    },
  },
  patients: {
    cell: 'patient:read',
    scope_es:
      'pacientes no eliminados, del país del usuario y sin alta; si el filtro nombra ALTA o DISCHARGED, se incluyen',
    fields: {
      stage: {
        field: 'stage',
        label_es: 'etapa',
        values: PATIENT_STAGE_VALUES,
        synonyms: ['estado', 'status', 'etapa'],
        shortcuts: {
          // grupos do dono (PatientStatus.ts): funil = ADMISSION_FUNNEL_STATUSES; atendimento = o resto do vocabulário
          admisión: ADMISSION_FUNNEL_STATUSES,
          'en atención': PATIENT_STATUSES.filter((s) => !isAdmissionFunnelStatus(s)),
        },
      },
      incomplete_registration: {
        field: 'incomplete_registration',
        label_es: 'cadastro incompleto (solo existe en admisión: restringe a ADMISSION y PENDING_ADMISSION)',
        values: BOOL,
        synonyms: ['registro incompleto', 'cadastro incompleto', 'ficha incompleta'],
      },
      has_provider: {
        field: 'has_provider',
        label_es: 'tiene prestador designado (al menos uno vigente)',
        values: BOOL,
        synonyms: ['prestador asignado', 'con AT', 'con acompañante', 'prestador designado'],
      },
    },
  },
  vacancies: {
    cell: 'vacancy:read',
    scope_es: 'vacantes no eliminadas ni borradores, sin cuentas de prueba y del país del usuario',
    fields: {
      status: {
        field: 'status',
        label_es: 'estado',
        values: VACANCY_STATUS_VALUES,
        synonyms: ['estado de la vacante', 'status'],
        shortcuts: { viva: OPEN_JOB_STATUSES },
      },
      zone: {
        field: 'zone',
        label_es: 'zona',
        values: ZONE_VALUES,
        synonyms: ['provincia', 'província', 'región'],
      },
      has_applicant: {
        field: 'has_applicant',
        label_es: 'tiene postulados',
        values: BOOL,
        synonyms: ['postulados', 'postulantes', 'candidatos'],
      },
    },
  },
};
