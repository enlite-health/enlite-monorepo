/**
 * AnaCareMirrorProvider — implementação de WorkerMirrorProvider para AnaCare.
 *
 * Usa AnaCareClient (HTTP) + anaCareMapper (conversão de vocabulário) +
 * AnaCareTypeResolver (resolução de tipos via catálogo).
 *
 * upsert:
 *   externalId === null → POST createNurse (worker nunca sincronizado)
 *   externalId !== null → PATCH updateNurse (worker já existe no AnaCare)
 *
 * deactivate: stub que faz PATCH com campo `status`.
 * TODO: confirmar campo e valor exato com AnaCare antes de usar em produção.
 *       Não é chamado no backfill v1.
 */

import type { WorkerMirrorProvider, WorkerMirrorUpsertResult } from '../../domain/WorkerMirrorProvider';
import type { WorkerMirrorRecord } from '../../domain/WorkerMirrorRecord';
import type { IAnaCareApiClient } from '../../domain/IAnaCareApiClient';
import { AnaCareTypeResolver } from './anaCareTypeResolver';
import { mapWorkerToAnaCarePayload } from './anaCareMapper';
import { logger } from '@shared/logging';

const TAG = '[AnaCareMirrorProvider]';

/**
 * Converte o externalId (ana_care_id) no id numérico que a API do AnaCare espera.
 *
 * O import do AnaCare grava o id COM prefixo alfabético (ex. "A86109"), mas o
 * endpoint /nurses/{id}/ usa o numérico ("86109" = mesma enfermeira, confirmado).
 * `parseInt("A86109")` é NaN → antes isso derrubava o mirror. Removemos os não-
 * dígitos primeiro. Retorna null quando não sobra dígito nenhum (dado inválido).
 */
export function toAnaCareNurseId(externalId: string): number | null {
  const digits = externalId.replace(/\D/g, '');
  if (!digits) return null;
  const id = parseInt(digits, 10);
  return isNaN(id) ? null : id;
}

export class AnaCareMirrorProvider implements WorkerMirrorProvider {
  readonly name = 'anacare';

  private readonly client: IAnaCareApiClient;
  private readonly typeResolver: AnaCareTypeResolver;

  constructor(client: IAnaCareApiClient) {
    this.client = client;
    this.typeResolver = new AnaCareTypeResolver(client);
  }

  async upsert(
    record: WorkerMirrorRecord,
    externalId: string | null,
  ): Promise<WorkerMirrorUpsertResult> {
    // Resolve tipos via catálogo (pode retornar campos vazios se não encontrado).
    // Prefere occupation (enum canônico AT/CUIDADOR/AMBOS) sobre profession (texto
    // livre, frequentemente NULL) para maximizar o match com o catálogo AnaCare.
    const resolvedTypes = await this.typeResolver.resolve(
      record.occupation ?? record.profession,
      record.employmentType,
    );

    if (externalId !== null) {
      // PATCH — worker já existe no AnaCare
      const id = toAnaCareNurseId(externalId);
      if (id === null) {
        throw new Error(
          `${TAG} upsert: invalid externalId (no numeric id): ${externalId}`,
        );
      }

      const payload = mapWorkerToAnaCarePayload(record, resolvedTypes);
      // Para PATCH, email não é enviado se já existe (evitar conflito de unicidade)
      // A API aceita PATCH com todos os campos — mantemos o payload completo.
      const updated = await this.client.updateNurse(id, payload);
      logger.info({ msg: `${TAG} updated nurse`, anaCareId: updated.id });
      return { externalId: String(updated.id) };
    }

    // POST — criar nova enfermera
    const payload = mapWorkerToAnaCarePayload(record, resolvedTypes);
    const created = await this.client.createNurse(payload);
    logger.info({ msg: `${TAG} created nurse`, anaCareId: created.id });
    return { externalId: String(created.id) };
  }

  /**
   * Desativa worker no AnaCare.
   *
   * TODO: confirmar com AnaCare o campo e valor corretos para desativação.
   *       O campo `status` e o valor abaixo são PLACEHOLDERS — a API AnaCare v2
   *       não documenta explicitamente o endpoint de desativação.
   *       NÃO é chamado no backfill v1.
   */
  async deactivate(externalId: string): Promise<void> {
    const id = toAnaCareNurseId(externalId);
    if (id === null) {
      throw new Error(
        `${TAG} deactivate: invalid externalId (no numeric id): ${externalId}`,
      );
    }
    // TODO: confirmar campo/valor de desativação com AnaCare antes de usar em produção.
    // A documentação v2 não especifica endpoint de desativação — pode ser PATCH status.
    await this.client.updateNurse(id, { /* status: 'INACTIVE' */ } as Record<string, unknown>);
    logger.info({ msg: `${TAG} deactivate called (stub — confirm field with AnaCare)`, anaCareId: id });
  }
}
