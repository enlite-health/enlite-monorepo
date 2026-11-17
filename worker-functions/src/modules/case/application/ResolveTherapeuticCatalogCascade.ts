/**
 * ResolveTherapeuticCatalogCascade — rota `POST /therapeutic-catalogs/cascade` (spec 091, §9.5, DD-10, DD-12).
 * URIs → categorias (`ResolveDiagnosisCategories`, DD-19) → `catalogFor` → um `CatalogBlock` por URI, na ordem
 * das URIs; o `status` vem de `CatalogBlock.status()` (DD-20). Só portas e domínio (hexagonal).
 * Padrão: caso de uso como classe com `execute()` e dependências injetadas.
 */
import { CatalogBlock, type BlockStatus, type CascadeObjective } from '../domain/TherapeuticDiagnosisPlan';
import type { TherapeuticCatalogCascadePort } from './ports/TherapeuticCatalogCascadePort';
import type { ResolveDiagnosisCategories } from './resolveDiagnosisCategories';

export interface CascadeBlockView {
  readonly diagnosisUri: string;
  readonly categoryCode: string | null;
  readonly status: BlockStatus;
  readonly objectives: readonly CascadeObjective[];
}

export interface CascadeView {
  readonly serviceCode: string;
  readonly serviceHasCatalog: boolean;
  readonly blocks: readonly CascadeBlockView[];
}

export class ResolveTherapeuticCatalogCascade {
  constructor(
    private readonly categories: ResolveDiagnosisCategories,
    private readonly catalog: TherapeuticCatalogCascadePort,
  ) {}

  async execute(cmd: { serviceCode: string; diagnosisUris: readonly string[] }): Promise<CascadeView> {
    const codes = (await this.categories.execute(cmd.diagnosisUris)).map((c) => c?.value ?? null);
    const wanted = [...new Set(codes.filter((c): c is string => c !== null))];
    const [byCategory, serviceHasCatalog] = await Promise.all([
      this.catalog.catalogFor(cmd.serviceCode, wanted),
      this.catalog.hasCatalog(cmd.serviceCode),
    ]);
    const blocks = cmd.diagnosisUris.map((diagnosisUri, i) => {
      const block = new CatalogBlock(codes[i], byCategory.get(codes[i] ?? '') ?? []);
      return { diagnosisUri, categoryCode: block.categoryCode, status: block.status(), objectives: block.objectives };
    });
    return { serviceCode: cmd.serviceCode, serviceHasCatalog, blocks };
  }
}
