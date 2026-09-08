/**
 * workerProfile.contrato.test.ts — a doc e a rota concordam sobre o 200 do
 * `PUT /api/workers/me/general-info`?
 *
 * O `200` desta rota tem DOIS ramos, e é fácil declarar só o bonito:
 *   (a) escrita confirmada  → o cadastro relido + `missingFields`;
 *   (b) escrita NÃO confirmada → `{ message, missingFields: null }`, sem perfil.
 *
 * O gate `revisao-pr` de 08/09/2026 pegou exatamente isso: o registro publicava
 * só `WorkerProfileSchema`, que exige `id`/`email`/`status`, enquanto o ramo (b)
 * devolve um objeto sem nenhum dos três. Um cliente gerado da spec quebraria
 * justamente no ramo que a mudança existe para tornar honesto.
 *
 * ⚠️ Este teste NÃO prova que os campos são os certos. Prova que o que a rota
 * DEVOLVE de verdade passa pelo que a doc DECLARA — a régua que faltava.
 */
import { z } from 'zod';
import { WorkerProfileSchema, UnconfirmedWrite } from '../worker';
import { UNCONFIRMED_WRITE } from '@modules/worker/interfaces/controllers/WorkerControllerV2Helpers';

const OK_200 = z.union([WorkerProfileSchema, UnconfirmedWrite]);

describe('contrato: o 200 declarado cobre os DOIS ramos que a rota devolve', () => {
  it('o objeto REAL do ramo degradado passa no schema publicado', () => {
    // `UNCONFIRMED_WRITE` é a constante que a rota devolve, importada — não uma
    // cópia escrita à mão aqui, que divergiria sem ninguém ver.
    expect(OK_200.safeParse(UNCONFIRMED_WRITE).success).toBe(true);
  });

  it('o ramo confirmado (cadastro relido + missingFields) passa no schema publicado', () => {
    const relido = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ana@example.com',
      status: 'INCOMPLETE_REGISTER',
      missingFields: ['phone', 'title_certificate'],
    };
    expect(OK_200.safeParse(relido).success).toBe(true);
  });

  it('`missingFields: []` é aceito no ramo confirmado — "apurei, nada falta"', () => {
    const completo = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ana@example.com',
      status: 'REGISTERED',
      missingFields: [],
    };
    expect(OK_200.safeParse(completo).success).toBe(true);
  });

  it('o ramo degradado NÃO pode declarar `[]` — "não sei" nunca vira "nada falta"', () => {
    // A distinção é a causa raiz da D302. Se alguém trocar `z.null()` por
    // `z.array(...)` aqui, o schema passaria a permitir que uma escrita não
    // confirmada se anunciasse completa.
    expect(UnconfirmedWrite.safeParse({ message: 'General info saved', missingFields: [] }).success)
      .toBe(false);
  });

  it('o instrumento enxerga: um objeto que não é nenhum dos dois ramos REPROVA', () => {
    // Contagem/aprovação no vácuo: sem este caso, um schema frouxo passaria em
    // tudo acima e o teste viraria decoração.
    expect(OK_200.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(OK_200.safeParse({ message: 'ok' }).success).toBe(false);
  });
});
