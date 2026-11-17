import type { CascadeObjective } from '../../domain/TherapeuticDiagnosisPlan';

/** Porta de leitura do catálogo por CID para a cascata do PTI (spec 091, §9.5). Só itens ativos; ordem DD-4. */
export interface TherapeuticCatalogCascadePort {
  /** Chave do Map = categoryCode pedido; categoria sem vínculo ativo fica com lista vazia. */
  catalogFor(serviceCode: string, categoryCodes: readonly string[]): Promise<Map<string, CascadeObjective[]>>;
  /** DD-12: existe objetivo ativo do serviço (derivado, nunca gravado). */
  hasCatalog(serviceCode: string): Promise<boolean>;
}
