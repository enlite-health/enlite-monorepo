/**
 * Motivo do quadro C (Servicio Contratado) — Fase 10, DX-10.3. Duas listas fechadas,
 * INDEPENDENTES das do quadro B (`matching/domain/moveReason.ts`, invariante 6): os dois
 * "Rejeitado" são setores diferentes, nenhum derivado do outro — a lista de reverter
 * coincide HOJE com `LEAVE_REJECTED_REASONS`, e é exatamente isso que não pode virar
 * acoplamento. O CHECK da migration 481 fixa os mesmos valores; o teste unitário confere
 * cada lista contra o literal do CHECK, escrito à mão (molde `moveReason.ts:37-42`): se a
 * migration mudar sem este arquivo, o teste quebra.
 */

/** Motivos de rejeitar um prestador do quadro C (DX-10.3). */
export const SERVICE_TEAM_REJECT_REASONS = [
  'PERFIL_INADEQUADO_AO_SERVICO',
  'INDISPONIBILIDADE_DE_HORARIO',
  'DESISTENCIA_DO_PRESTADOR',
  'OTHER',
] as const;

/** Motivos de reverter uma marca de rejeição do quadro C (DX-10.3). */
export const SERVICE_TEAM_REVERT_REASONS = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'] as const;

export type ServiceTeamReasonKind = 'REJECT' | 'REVERT';

const SERVICE_TEAM_REASONS_BY_KIND: Record<ServiceTeamReasonKind, readonly string[]> = {
  REJECT: SERVICE_TEAM_REJECT_REASONS,
  REVERT: SERVICE_TEAM_REVERT_REASONS,
};

/** A categoria enviada está na lista permitida para esse tipo de motivo do quadro C? */
export function isAllowedServiceTeamReason(kind: ServiceTeamReasonKind, value: unknown): boolean {
  return typeof value === 'string' && SERVICE_TEAM_REASONS_BY_KIND[kind].includes(value);
}

/** 422 — o quadro C pede `reasonCategory` e o corpo não trouxe. */
export class ServiceTeamReasonRequiredError extends Error {
  constructor(readonly kind: ServiceTeamReasonKind) {
    super(`service team reason required for kind: ${kind}`);
    this.name = 'ServiceTeamReasonRequiredError';
  }
}

/** 422 — `reasonCategory` veio fora da lista permitida para `kind` no quadro C. */
export class ServiceTeamReasonInvalidError extends Error {
  constructor(readonly kind: ServiceTeamReasonKind) {
    super(`service team reason invalid for kind: ${kind}`);
    this.name = 'ServiceTeamReasonInvalidError';
  }
}
