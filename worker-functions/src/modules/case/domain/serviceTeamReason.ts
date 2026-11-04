/**
 * Motivo do quadro C (Servicio Contratado) — Fase 10, DX-10.3. O motivo de REJEITAR deixou de ser
 * lista fixa no código: desde a migration 493 (change itinerario-trocas-motivos-e-figma, Fase 2, D2)
 * é o `code` de um item ATIVO do catálogo `service_exit_reasons` (FK `csr_reject_reason_fk`),
 * conferido por `ServiceExitReasonReader.findActiveByCode` em `ServiceTeamMarkUseCase`. Sobra aqui a
 * lista fechada do motivo de REVERTER, INDEPENDENTE da do quadro B (`matching/domain/moveReason.ts`,
 * invariante 6): os dois "Rejeitado" são setores diferentes, nenhum derivado do outro. O CHECK da
 * migration 481 (`csr_revert_reason_check`) fixa os mesmos valores; o teste unitário confere a lista
 * contra o literal do CHECK, escrito à mão (molde `moveReason.ts:37-42`): se a migration mudar sem
 * este arquivo, o teste quebra.
 */

/** Motivos de reverter uma marca de rejeição do quadro C (DX-10.3). */
export const SERVICE_TEAM_REVERT_REASONS = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'] as const;

export type ServiceTeamReasonKind = 'REJECT' | 'REVERT';

/** A categoria enviada está na lista fechada de motivos de REVERTER? (o de rejeitar é o catálogo, ver acima) */
export function isAllowedServiceTeamRevertReason(value: unknown): boolean {
  return typeof value === 'string' && (SERVICE_TEAM_REVERT_REASONS as readonly string[]).includes(value);
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
