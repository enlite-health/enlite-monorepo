/**
 * contact-notes-test-helper.ts
 *
 * Direct DB helpers for the WJA contact-notes visual integration test.
 * Insere notas com autor/timestamp arbitrários pra exercitar as regras de
 * exclusão (autor + janela de 2h) com DADOS REAIS no banco do backend.
 *
 * Usa `docker exec enlite-postgres psql` (mesmo padrão de db-test-helper.ts)
 * pra não puxar `pg` como dependência do frontend.
 */

import { execSync } from 'child_process';

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message}`);
  }
}

export interface InsertContactNoteOpts {
  wjaId: string;
  noteText: string;
  createdByAdminId: string;
  createdByAdminName?: string | null;
  createdByAdminEmail?: string | null;
  /** Quantos minutos no passado a nota foi criada (default 0 = agora). */
  ageMinutes?: number;
}

/** Insere uma nota de contato direto no banco e devolve o id. */
export function insertContactNote(opts: InsertContactNoteOpts): string {
  const {
    wjaId,
    noteText,
    createdByAdminId,
    createdByAdminName = null,
    createdByAdminEmail = null,
    ageMinutes = 0,
  } = opts;

  const name = createdByAdminName === null ? 'NULL' : `'${createdByAdminName.replace(/'/g, "''")}'`;
  const email = createdByAdminEmail === null ? 'NULL' : `'${createdByAdminEmail.replace(/'/g, "''")}'`;

  const out = runSQL(
    `INSERT INTO wja_contact_notes
       (worker_job_application_id, note_text, created_by_admin_id, created_by_admin_name, created_by_admin_email, created_at)
     VALUES (
       '${wjaId}',
       '${noteText.replace(/'/g, "''")}',
       '${createdByAdminId}',
       ${name},
       ${email},
       NOW() - INTERVAL '${ageMinutes} minutes'
     )
     RETURNING id`,
  );

  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`Could not extract contact note id from: ${out}`);
  return match[0];
}

/** Remove todas as notas de uma WJA. */
export function cleanupContactNotes(wjaId: string): void {
  runSQL(`DELETE FROM wja_contact_notes WHERE worker_job_application_id = '${wjaId}'`);
}
