/**
 * ResolveDiagnosisCategories — DONO ÚNICO de "URI de diagnóstico → categoria CID-11" (spec 091, DD-19, vistoria A2).
 * `TerminologyPort.getByUri` → `null` = 422 (`DiagnosisUnknownError`, molde de `derivePathologySegments`) →
 * `IcdCategoryCode.fromConceptCode(entity.code.value)` (código CRU, não `.stem`; DF-5). Só a porta: nenhum adaptador.
 * Nunca loga a URI (texto clínico identificado): o erro tipado é o status. `TerminologyUnavailableError` propaga (503).
 * Padrão: Value Object (`IcdCategoryCode`) devolvido por um serviço de aplicação de uma responsabilidade.
 */
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import { IcdCategoryCode } from '../domain/icdCategory';
import { DiagnosisUnknownError } from './pathologySegments';

export class ResolveDiagnosisCategories {
  constructor(private readonly terminology: Pick<TerminologyPort, 'getByUri'>) {}

  /** Uma categoria por URI, ALINHADA por índice (URI repetida resolve uma vez); `null` = sem categoria (DF-5). */
  async execute(uris: readonly string[]): Promise<(IcdCategoryCode | null)[]> {
    const byUri = new Map<string, IcdCategoryCode | null>();
    for (const uri of new Set(uris)) byUri.set(uri, await this.categoryOf(uri));
    return uris.map((uri) => byUri.get(uri) ?? null);
  }

  private async categoryOf(uri: string): Promise<IcdCategoryCode | null> {
    const entity = await this.terminology.getByUri(uri);
    if (entity === null) throw new DiagnosisUnknownError();
    return IcdCategoryCode.fromConceptCode(entity.code.value);
  }
}
