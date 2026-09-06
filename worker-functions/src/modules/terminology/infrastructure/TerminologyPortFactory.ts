/**
 * createTerminologyPort — Strategy (spec 016, tabela de padrões GoF): "a implementação da
 * TerminologyPort escolhida por CONFIGURAÇÃO" (OCP) — nunca um `if (fonte === 'icd')` espalhado
 * pelo caso de uso. Único ponto do código de produção que decide QUAL adaptador vive atrás da
 * porta; um adaptador novo (SNOMED, um servidor real Ontoserver/Snowstorm) entra aqui, sem tocar
 * em quem consome `TerminologyPort`.
 */
import type { TerminologyPort } from '../domain/TerminologyPort';
import { UnavailableTerminology } from '../domain/UnavailableTerminology';
import { IcdCatalogTerminology } from './IcdCatalogTerminology';

export type TerminologyAdapterName = 'postgres' | 'unavailable';

export interface TerminologyPortFactoryEnv {
  TERMINOLOGY_ADAPTER?: string;
}

export function createTerminologyPort(env: TerminologyPortFactoryEnv): TerminologyPort {
  const adapter = env.TERMINOLOGY_ADAPTER ?? 'postgres';

  switch (adapter) {
    case 'postgres':
      return new IcdCatalogTerminology();
    case 'unavailable':
      return new UnavailableTerminology('forçado por configuração');
    default:
      // Falha VISÍVEL na configuração — nunca cai silenciosamente para um adaptador default
      // quando alguém digitou o nome errado (o mesmo espírito da US-4: não fingir sucesso).
      throw new Error(
        `TERMINOLOGY_ADAPTER inválido: "${adapter}". Valores aceitos: "postgres" (default), "unavailable".`,
      );
  }
}
