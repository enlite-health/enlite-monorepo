/**
 * WorkerProfilePhotoRepository
 *
 * A foto de perfil NÃO mora em bucket: é um data-URL JPEG gravado, cifrado por KMS, em
 * `workers.profile_photo_url_encrypted` (WorkerPersonalInfoRepository). Apagar = zerar essa
 * coluna — não há objeto de storage a remover. O PATCH/PUT de perfil nunca apaga (COALESCE);
 * esta é a única escrita que zera, e só por rota explícita da própria prestadora (D815).
 */
import { Pool } from 'pg';
import { Result } from '@shared/utils/Result';

/** Idempotente: sem foto o UPDATE só toca `updated_at` e continua sucesso. Sem foto no log, nunca. */
export async function clearProfilePhoto(pool: Pool, workerId: string): Promise<Result<void>> {
  try {
    await pool.query(
      'UPDATE workers SET profile_photo_url_encrypted = NULL, updated_at = NOW() WHERE id = $1',
      [workerId],
    );
    return Result.ok<void>();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return Result.fail<void>(`Failed to clear profile photo: ${msg}`);
  }
}
