/**
 * Config do aviso da importação bloqueada à GESTÃO (spec 083, D-6): quem recebe o `will_be_lost` vem de env, nunca do código.
 *
 * `ADMISSION_IMPORT_SUPERVISOR_EMAILS` = e-mails separados por `;` (o workflow de deploy manda `;` em listas de env — vírgula quebra o
 * parse do `env_vars`). Minúsculas, sem repetição. Entrada de formato inválido é DESCARTADA e devolvida em `invalid` (o chamador só
 * conta/loga, sem o valor: e-mail é dado pessoal). Ausente/vazio = lista vazia; nunca lança. Mudar a lista = editar o workflow.
 */
export const SUPERVISOR_EMAILS_ENV = 'ADMISSION_IMPORT_SUPERVISOR_EMAILS';

const EMAIL_RE = /^[^\s@;]+@[^\s@;]+\.[^\s@;]+$/;

export interface SupervisorEmails {
  emails: string[];
  invalid: string[];
}

export function supervisorEmails(env: Record<string, string | undefined> = process.env): SupervisorEmails {
  const raw = env[SUPERVISOR_EMAILS_ENV];
  const out: SupervisorEmails = { emails: [], invalid: [] };
  if (raw === undefined) return out;
  for (const part of raw.split(';').map((p) => p.trim().toLowerCase()).filter((p) => p !== '')) {
    if (!EMAIL_RE.test(part)) out.invalid.push(part);
    else if (!out.emails.includes(part)) out.emails.push(part);
  }
  return out;
}
