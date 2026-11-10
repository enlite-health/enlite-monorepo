import { Result } from '@shared/utils/Result';
import { SYNTHETIC_AUTH_UID_PREFIXES } from '../../../infrastructure/services/WorkerPhoneMergeTypes';
import type { IWorkerRepository } from '../ports/IWorkerRepository';

/**
 * Ficha IMPORTADA (auth_uid sintético reclamável). Definição ÚNICA (D514): usada pelo claim
 * (busca e confirm) e pelo InitWorkerUseCase.
 *
 * Reaproveita a lista de sintéticos (SSOT: WorkerPhoneMergeTypes). `talentum_` é sintético mas NÃO
 * é reclamável (de propósito: ver syntheticPrefixesParity.test.ts), por isso sai daqui.
 */
const IMPORT_PREFIXES = SYNTHETIC_AUTH_UID_PREFIXES.filter((p) => p !== 'talentum_');

export function isImportedWorker(authUid: string | null | undefined): boolean {
  if (!authUid) return false;
  return IMPORT_PREFIXES.some((prefix) => authUid.startsWith(prefix));
}

/**
 * Pode ser reclamada via OTP: importada E que não absorveu uma ficha de login real.
 * A sobrevivente sintética de um merge que engoliu um login real não é reclamável: reclamá-la
 * entregaria o histórico de outra pessoa a quem só prova o telefone (P5/A, 09/11).
 * Só restringe. Falha de leitura vira Result.fail (nunca "reclamável" por omissão).
 */
export async function isClaimableWorker(
  workerRepository: Pick<IWorkerRepository, 'hasAbsorbedRealLogin'>,
  ficha: { id: string; authUid?: string | null },
): Promise<Result<boolean>> {
  if (!isImportedWorker(ficha.authUid)) return Result.ok(false);
  const absorbed = await workerRepository.hasAbsorbedRealLogin(ficha.id);
  if (absorbed.isFailure) return Result.fail<boolean>(absorbed.error!);
  return Result.ok(!absorbed.getValue());
}
