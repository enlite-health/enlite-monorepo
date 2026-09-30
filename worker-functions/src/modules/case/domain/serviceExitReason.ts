import type { TherapeuticCatalogKind } from './TherapeuticProject';

/**
 * Catálogo de motivos de saída do serviço (migration 492). Entra no mecanismo genérico dos
 * catálogos terapêuticos, mas FORA de `THERAPEUTIC_CATALOG_KINDS`: o projeto terapêutico, seus
 * schemas e sua tela nunca o veem.
 */
export const SERVICE_EXIT_REASON_KIND = 'service-exit-reasons' as const;
export const SERVICE_EXIT_REASON_TABLE = 'service_exit_reasons';
export const SERVICE_EXIT_REASON_RESOURCE = 'catalog_service_exit_reasons';

/** Kind aceito pelo repositório/rotas/controller de catálogo: os terapêuticos + o de motivos de saída. */
export type AdminCatalogKind = TherapeuticCatalogKind | typeof SERVICE_EXIT_REASON_KIND;

/** Os 4 códigos que já existiam como CHECK da 481 e que a 492 carrega como linhas do catálogo. */
export const LEGACY_REJECT_REASON_CODES = [
  'PERFIL_INADEQUADO_AO_SERVICO',
  'INDISPONIBILIDADE_DE_HORARIO',
  'DESISTENCIA_DO_PRESTADOR',
  'OTHER',
] as const;

/** 422 — a troca pede um motivo de saída e o corpo não trouxe. */
export class ServiceExitReasonRequiredError extends Error {
  constructor() {
    super('service exit reason required');
    this.name = 'ServiceExitReasonRequiredError';
  }
}

/** 422 — o motivo enviado não existe no catálogo ou está inativo. */
export class ServiceExitReasonInvalidError extends Error {
  constructor() {
    super('service exit reason invalid');
    this.name = 'ServiceExitReasonInvalidError';
  }
}

/** 422 — a troca pede um destino e o corpo não trouxe. */
export class DestinationRequiredError extends Error {
  constructor() {
    super('destination required');
    this.name = 'DestinationRequiredError';
  }
}
