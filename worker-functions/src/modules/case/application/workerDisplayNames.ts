/**
 * workerDisplayNames — a projeção do nome do prestador numa fonte só (Fase 12, DX-12.5 (3), DX-12.12 (iii)).
 *
 * O bloco saiu MOVIDO, sem mudança, de `projectServiceTeamDisplayNames` (quadro C, Fase 10); o GET do
 * itinerário (Fase 12) chama a MESMA função — nunca uma cópia. A decisão por célula (`cells === null`
 * = engine OFF; sem `worker_contact:read` = sem nome) é de `projectWorkerFields`, ANTES do KMS (D113).
 * Um decrypt por prestador DISTINTO (a chave do mapa), em PARALELO (`Promise.all`). O nome redigido
 * vira `null` — a resposta nunca carrega o marcador de redação.
 */
import { projectWorkerFields, NOME_REDIGIDO, type Decryptor } from '@modules/identity/permissions';

export interface WorkerNameSource {
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export async function projectWorkerDisplayNames(
  sourceByWorkerId: Map<string, WorkerNameSource>,
  cells: string[] | null,
  kms: Decryptor,
): Promise<Map<string, string | null>> {
  const projected = await Promise.all(
    [...sourceByWorkerId.entries()].map(async ([workerId, source]) => {
      const result = await projectWorkerFields(
        cells,
        { firstNameEncrypted: source.firstNameEncrypted, lastNameEncrypted: source.lastNameEncrypted, phone: null },
        kms,
      );
      const displayName = result.name && result.name !== NOME_REDIGIDO ? result.name : null;
      return [workerId, displayName] as const;
    }),
  );

  return new Map(projected);
}
