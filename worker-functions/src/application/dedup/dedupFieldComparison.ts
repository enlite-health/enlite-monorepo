/**
 * dedupFieldComparison
 *
 * Módulo compartilhado de comparação campo-a-campo para dedup.
 *
 * Exporta:
 *   - ENCRYPTED_FIELDS   — Set de nomes de colunas encriptadas (KMS)
 *   - COMPARE_FIELDS     — lista de campos para comparação campo-a-campo
 *   - buildFieldComparisons(rows, fields, encryptionService) → Promise<FieldComparison[]>
 *
 * Usado por:
 *   - GetDedupGroupDetailUseCase  (aba Fila / detalhe do grupo)
 *   - BuildManualDedupGroupUseCase (aba Merge Manual)
 *
 * PII encriptada: endpoint admin-only em ambos os cases. Valor é decriptado via
 * KMS para permitir comparação legível — mesmo padrão da ficha do prestador.
 * `is_encrypted=true` permanece no shape para a UI sinalizar dado sensível.
 */

import { reportError } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { FieldComparison } from './DedupTypes';

// ── Campos encriptados (PII KMS) ───────────────────────────────────────────

export const ENCRYPTED_FIELDS = new Set([
  'first_name_encrypted',
  'last_name_encrypted',
  'sex_encrypted',
  'gender_encrypted',
  'birth_date_encrypted',
  'document_number_encrypted',
  'languages_encrypted',
  'profile_photo_url_encrypted',
  'whatsapp_phone_encrypted',
  'linkedin_url_encrypted',
  'sexual_orientation_encrypted',
  'race_encrypted',
  'religion_encrypted',
  'weight_kg_encrypted',
  'height_cm_encrypted',
]);

// ── Campos para comparação campo-a-campo ────────────────────────────────────

export const COMPARE_FIELDS: string[] = [
  'profession',
  'knowledge_level',
  'years_experience',
  'status',
  'country',
  'data_sources',
  ...Array.from(ENCRYPTED_FIELDS),
];

// ── Helper: flag de PII presente ────────────────────────────────────────────

export function ENCRYPTED_FIELDS_PRESENT(row: Record<string, unknown>): boolean {
  return Array.from(ENCRYPTED_FIELDS).some(f => row[f] != null);
}

// ── Comparação campo-a-campo ─────────────────────────────────────────────────

/**
 * Gera a lista de comparações campo-a-campo para um grupo de contas.
 *
 * @param fields  Lista de campos a comparar (geralmente COMPARE_FIELDS).
 * @param rows    Linhas do banco — devem conter as colunas listadas em `fields`.
 * @param encryptionService  KMSEncryptionService (passthrough em NODE_ENV=test).
 */
export async function buildFieldComparisons(
  fields: string[],
  rows: Record<string, unknown>[],
  encryptionService: KMSEncryptionService,
): Promise<FieldComparison[]> {
  if (rows.length < 2) return [];

  return Promise.all(
    fields.map(field => buildSingleFieldComparison(field, rows, encryptionService)),
  );
}

// ── Helpers internos ────────────────────────────────────────────────────────

async function buildSingleFieldComparison(
  field: string,
  rows: Record<string, unknown>[],
  encryptionService: KMSEncryptionService,
): Promise<FieldComparison> {
  const isEncrypted = ENCRYPTED_FIELDS.has(field);

  // values: por account id. Para encriptado, DECRIPTA o ciphertext (uso
  // autorizado — endpoint admin-only; mesmo PII visível na ficha do prestador).
  const values: Record<string, string | null> = {};
  for (const row of rows) {
    const id = String(row.id);
    const raw = row[field];
    values[id] = isEncrypted
      ? await decryptFieldValue(encryptionService, raw, field, id)
      : raw == null || raw === ''
        ? null
        : stringifyValue(raw);
  }

  // Conflito: ao menos 2 valores não-null distintos. Para encriptado, compara
  // o PLAINTEXT decriptado (o ciphertext KMS é não-determinístico — mesmo valor
  // gera bytes diferentes, então comparar ciphertext daria falso conflito).
  const cmpVals = Object.values(values).filter((v): v is string => v != null && v !== '');
  const hasConflict = cmpVals.length > 1 && new Set(cmpVals).size > 1;

  return { field, values, is_encrypted: isEncrypted, has_conflict: hasConflict };
}

/**
 * Decripta 1 campo encriptado de 1 conta. Erro de decrypt é gracioso: loga e
 * retorna null pro campo, sem derrubar o endpoint (uma chave/registro corrompido
 * não pode quebrar a comparação inteira do grupo).
 */
async function decryptFieldValue(
  encryptionService: KMSEncryptionService,
  raw: unknown,
  field: string,
  workerId: string,
): Promise<string | null> {
  if (raw == null || raw === '') return null;
  try {
    const plaintext = await encryptionService.decrypt(String(raw));
    return plaintext === '' ? null : plaintext;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: 'dedupFieldComparison:decryptFieldValue', field, workerId });
    return null;
  }
}

function stringifyValue(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(v => String(v)).join(', ');
  return String(raw);
}
