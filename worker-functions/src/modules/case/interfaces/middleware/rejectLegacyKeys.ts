/**
 * rejectLegacyKeys — recusa, com 422 `LEGACY_FIELD_REMOVED`, o corpo que ainda traz uma chave que a spec 058 tirou do fio
 * (`hourlyValue`, `contractType`, `taxCondition`, `healthInsuranceMemberId`). Roda ANTES de `perm.require` (spec 058 §2.5, plan §1.4):
 * a resposta tem de ser a mesma para qualquer ator, com ou sem célula — um bundle de front antigo em cache recebe o 422 e não um 403 que
 * esconderia o motivo. Só olha as CHAVES do corpo (nível raiz); o VALOR nunca vai para a resposta nem para log.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const LEGACY_FIELD_REMOVED = 'LEGACY_FIELD_REMOVED';

/** Chaves removidas do contrato de serviço contratado (preço, tipo de contratação e condição fiscal agora vêm do contrato/termo). */
export const LEGACY_SERVICE_KEYS = ['hourlyValue', 'contractType', 'taxCondition'] as const;
/** Chave removida do contrato de cobertura (o dono do número de afiliado é `affiliateId`). */
export const LEGACY_COVERAGE_KEYS = ['healthInsuranceMemberId'] as const;

export function rejectLegacyKeys(keys: readonly string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as unknown;
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const found = keys.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
      if (found.length > 0) {
        res.status(422).json({ success: false, error: LEGACY_FIELD_REMOVED, code: LEGACY_FIELD_REMOVED, details: { fields: found } });
        return;
      }
    }
    next();
  };
}
