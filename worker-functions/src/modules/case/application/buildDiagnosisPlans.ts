/**
 * BuildDiagnosisPlans — monta e valida os blocos por diagnóstico da versão do PTI (spec 091, §9.5, DD-19/DD-20).
 * Resolve as categorias (`ResolveDiagnosisCategories`), pede `catalogFor` e delega a `validateDiagnosisPlans`.
 * A porta da cascata chega JÁ LIGADA à transação (o repositório do PTI passa `new PgTherapeuticCatalogCascade(cli)`):
 * esta classe não conhece `pg`. Padrão: caso de uso como classe com `execute()` e dependências injetadas.
 */
import {
  CatalogBlock,
  validateDiagnosisPlans,
  type DiagnosisPlanInput,
  type DiagnosisPlanSnapshot,
} from '../domain/TherapeuticDiagnosisPlan';
import type { TherapeuticCatalogCascadePort } from './ports/TherapeuticCatalogCascadePort';
import type { ResolveDiagnosisCategories } from './resolveDiagnosisCategories';

export class BuildDiagnosisPlans {
  constructor(
    private readonly categories: ResolveDiagnosisCategories,
    private readonly catalog: TherapeuticCatalogCascadePort,
  ) {}

  async execute(serviceCode: string, inputs: readonly DiagnosisPlanInput[]): Promise<DiagnosisPlanSnapshot[]> {
    const codes = (await this.categories.execute(inputs.map((i) => i.diagnosisUri))).map((c) => c?.value ?? null);
    const wanted = [...new Set(codes.filter((c): c is string => c !== null))];
    const byCategory = await this.catalog.catalogFor(serviceCode, wanted);
    const blocks = codes.map((code) => new CatalogBlock(code, byCategory.get(code ?? '') ?? []));
    return validateDiagnosisPlans(inputs, blocks);
  }
}
