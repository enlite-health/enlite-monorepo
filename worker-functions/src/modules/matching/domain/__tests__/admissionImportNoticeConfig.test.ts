import { supervisorEmails } from '../admissionImportNoticeConfig';

const env = (v?: string): Record<string, string | undefined> => ({ ADMISSION_IMPORT_SUPERVISOR_EMAILS: v });

describe('supervisorEmails (spec 083, D-6)', () => {
  it('ausente, vazio ou só separadores -> lista vazia, nada inválido', () => {
    for (const v of [undefined, '', '   ', ';;']) expect(supervisorEmails(env(v))).toEqual({ emails: [], invalid: [] });
  });

  it('separa por ";", aplica trim e minúsculas', () => {
    expect(supervisorEmails(env(' a@x.com ;B@X.com'))).toEqual({ emails: ['a@x.com', 'b@x.com'], invalid: [] });
  });

  it('duplicata (mesmo com caixa diferente) entra uma vez', () => {
    expect(supervisorEmails(env('a@x.com;A@X.COM;a@x.com')).emails).toEqual(['a@x.com']);
  });

  it('entrada inválida é descartada e reportada; as válidas ficam; vírgula NÃO é separador', () => {
    expect(supervisorEmails(env('a@x.com;semarroba;b@x'))).toEqual({ emails: ['a@x.com'], invalid: ['semarroba', 'b@x'] });
    expect(supervisorEmails(env('a@x.com,b@x.com')).emails).toEqual([]);
  });

  it('lê process.env por padrão e nunca lança', () => {
    const before = process.env.ADMISSION_IMPORT_SUPERVISOR_EMAILS;
    process.env.ADMISSION_IMPORT_SUPERVISOR_EMAILS = 'p@x.com';
    try { expect(supervisorEmails().emails).toEqual(['p@x.com']); } finally {
      if (before === undefined) delete process.env.ADMISSION_IMPORT_SUPERVISOR_EMAILS; else process.env.ADMISSION_IMPORT_SUPERVISOR_EMAILS = before;
    }
  });
});
