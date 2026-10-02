/**
 * CSV de rollback da reconciliação Talentum v2 (spec 040 / F5 / T5.2): `job_posting_id` + os 4 valores
 * ANTIGOS de `talentum_*` que a reconciliação sobrescreve. NUNCA carrega título nem PII.
 *
 * Codificação sem perda (RFC 4180 + distinção NULL × vazio): `NULL` = campo vazio SEM aspas; string vazia
 * = `""`; todo campo com `,` `"` ou quebra de linha vai entre aspas (`"` dobrado). Assim restaurar o CSV
 * devolve o banco byte a byte, inclusive onde o valor antigo era NULL.
 */

export interface RollbackRow {
  jobPostingId: string;
  projectId: string | null;
  publicId: string | null;
  slug: string | null;
  whatsappUrl: string | null;
}

export const ROLLBACK_CSV_HEADER =
  'job_posting_id,talentum_project_id,talentum_public_id,talentum_slug,talentum_whatsapp_url';

function encodeField(value: string | null): string {
  if (value === null) return '';
  if (value === '' || /[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function serializeRollbackCsv(rows: RollbackRow[]): string {
  const lines = rows.map((r) =>
    [r.jobPostingId, r.projectId, r.publicId, r.slug, r.whatsappUrl].map(encodeField).join(','),
  );
  return `${[ROLLBACK_CSV_HEADER, ...lines].join('\n')}\n`;
}

/** Quebra o texto em registros de campos; `null` = campo vazio sem aspas, `''` = campo `""`. */
function parseRecords(text: string): Array<Array<string | null>> {
  const records: Array<Array<string | null>> = [];
  let fields: Array<string | null> = [];
  let buf = '';
  let quoted = false;
  let inQuotes = false;

  const endField = () => {
    fields.push(quoted || buf !== '' ? buf : null);
    buf = '';
    quoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        buf += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        buf += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      quoted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endField();
      records.push(fields);
      fields = [];
    } else {
      buf += ch;
    }
  }
  if (inQuotes) throw new Error('rollback CSV: aspas sem fechar');
  if (buf !== '' || quoted || fields.length > 0) {
    endField();
    records.push(fields);
  }
  return records;
}

export function parseRollbackCsv(text: string): RollbackRow[] {
  const [header, ...records] = parseRecords(text);
  if (!header || header.join(',') !== ROLLBACK_CSV_HEADER) {
    throw new Error('rollback CSV: cabeçalho inesperado');
  }
  return records.map((f, i) => {
    if (f.length !== 5 || !f[0]) throw new Error(`rollback CSV: linha ${i + 2} inválida`);
    return { jobPostingId: f[0], projectId: f[1], publicId: f[2], slug: f[3], whatsappUrl: f[4] };
  });
}
