/** P1 (spec 084): baixa à mão só em vaga SEM serviço e ainda não baixada. Fonte única da seleção do lote. */
export const isBajaSelectable = (row: { hasService?: boolean; statusRaw?: string | null }): boolean =>
  row.hasService !== true && row.statusRaw !== 'DE_BAJA';
