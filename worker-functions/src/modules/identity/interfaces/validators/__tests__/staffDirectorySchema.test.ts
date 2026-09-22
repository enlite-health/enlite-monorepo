/**
 * staffDirectorySchema — TDD (change 022-ux-mencao-e-notificacao, item 1). Molde:
 * `notificationSchemas.test.ts` (schema puro, sem I/O).
 *
 * Revoga D-06 (`specs/022-chat-interno-por-paciente/spec.md:40`, "2+ caracteres"): `q`
 * ausente/vazio agora É aceito (lista os primeiros N do diretório) — só `q` com 1 caractere
 * continua recusado (piso de busca por TEXTO, inalterado, F2 de `fatos-medidos.md`).
 */
import { staffDirectoryQuerySchema } from '../staffDirectorySchema';

describe('staffDirectoryQuerySchema (item 1: q ausente/vazio vira "listar primeiros N")', () => {
  it('q ausente: válido, q sai undefined', () => {
    const result = staffDirectoryQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBeUndefined();
  });

  it('q vazio (?q=): válido, q sai string vazia', () => {
    const result = staffDirectoryQuerySchema.safeParse({ q: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('');
  });

  it('q só com espaços: trim vira vazio, continua válido (mesmo tratamento de ausente)', () => {
    const result = staffDirectoryQuerySchema.safeParse({ q: '   ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('');
  });

  it('q com 1 caractere: RECUSADO (piso de busca por texto inalterado)', () => {
    const result = staffDirectoryQuerySchema.safeParse({ q: 'a' });
    expect(result.success).toBe(false);
  });

  it('q com 2+ caracteres: válido, mantém comportamento atual', () => {
    const result = staffDirectoryQuerySchema.safeParse({ q: 'ana' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.q).toBe('ana');
  });
});
