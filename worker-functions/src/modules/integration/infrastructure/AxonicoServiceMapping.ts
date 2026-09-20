/**
 * AxonicoServiceMapping — mapa de tipo de serviço Enlite → códigos do Axonico (D369).
 *
 * DADO, não `if`/`switch`: adicionar um tipo novo é acrescentar uma linha ao objeto, nunca um
 * ramo de código. `resolveServiceMapping` nunca cai em `AT` por default — tipo ausente do mapa
 * lança `AxonicoUnmappedServiceTypeError` explícito.
 *
 * Hoje só `AT` está mapeado: `servicioOrigen: '1111'` (RED CAPITAL — decidido por Gabriel em
 * 18/09/2026: "sempre passamos para eles Red Capital e Acompanhamento terapeutico QUANDO É AT";
 * `1122`/RED PCIA. existe no cardápio mas não é usado hoje), `codigoEspecialidad: '17'`
 * (ACOMPAÑAMIENTO TERAPEUTICO), `codigo: '330123'`, `subcodigo: '0'` — todos medidos em
 * `docs/funcionalidades/integracao-axonico/estado-integracao-axonico.md` (18/09/2026).
 *
 * `CAREGIVER` está FORA do mapa por decisão (D372, Gabriel 18/09/2026): "não existe lançamento
 * desse perfil de prestador hoje para o Axonico". Não é pendência técnica desta change — o
 * comportamento correto e suficiente é `resolveServiceMapping('CAREGIVER')` lançar
 * `AxonicoUnmappedServiceTypeError`.
 */

import type { EnliteServiceType } from '../domain/EnliteServiceType';
import type { AxonicoServiceCodes } from '../domain/IAxonicoApiClient';

export const AXONICO_SERVICE_MAP: Partial<Record<EnliteServiceType, AxonicoServiceCodes>> = {
  AT: {
    servicioOrigen: '1111', // RED CAPITAL — decidido por Gabriel em 18/09/2026
    codigoEspecialidad: '17',
    codigo: '330123',
    subcodigo: '0',
  },
  // CAREGIVER, NURSE, KINESIOLOGIST, PSYCHOLOGIST: fora do mapa hoje (D372 para CAREGIVER — "não
  // existe lançamento desse perfil de prestador hoje para o Axonico"; os demais nunca foram sequer
  // discutidos com a operadora). Adicionar é acrescentar uma entrada aqui, nunca um `if`/`switch`
  // novo.
};

/**
 * AxonicoUnmappedServiceTypeError — tipo de serviço sem entrada em `AXONICO_SERVICE_MAP`.
 *
 * Vive aqui (não em `AxonicoErrors.ts`) porque é erro do MAPA, não da chamada HTTP — pode ser
 * lançado antes de qualquer requisição de rede, inclusive antes do login (o use case em F3 chama
 * `resolveServiceMapping` antes de tocar rede — ver `design.md` §F3, guard de dedupe passo b).
 */
export class AxonicoUnmappedServiceTypeError extends Error {
  readonly serviceType: EnliteServiceType;

  constructor(serviceType: EnliteServiceType) {
    super(`[AxonicoServiceMapping] tipo de serviço sem mapeamento no Axonico: '${serviceType}'`);
    this.name = 'AxonicoUnmappedServiceTypeError';
    this.serviceType = serviceType;
  }
}

/**
 * Resolve o mapeamento de `serviceType` ou lança `AxonicoUnmappedServiceTypeError`. NUNCA cai em
 * `AT` por default (D369) — um tipo ausente do mapa é sempre um erro explícito.
 */
export function resolveServiceMapping(serviceType: EnliteServiceType): AxonicoServiceCodes {
  const mapping = AXONICO_SERVICE_MAP[serviceType];
  if (!mapping) {
    throw new AxonicoUnmappedServiceTypeError(serviceType);
  }
  return mapping;
}
