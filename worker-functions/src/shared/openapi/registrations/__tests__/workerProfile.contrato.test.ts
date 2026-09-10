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
import { UnconfirmedWrite, WorkerGeneralInfoOk200 } from '../worker';
import { buildOpenApiDocument } from '../../document';
import { UNCONFIRMED_WRITE } from '@modules/worker/interfaces/controllers/WorkerControllerV2Helpers';

/**
 * A MESMA constante que o `registerPath` publica — não uma união remontada aqui.
 *
 * A 1ª versão deste teste montava `z.union([...])` localmente, e a sabotagem S4
 * do gate (rodada 4) provou que ele ficava VERDE mesmo trocando o `schema` da
 * rota de volta para só o perfil: media os schemas, não a declaração da rota.
 * Instrumento morto é pior que teste ausente — o ausente ninguém confunde com
 * garantia.
 */
const OK_200 = WorkerGeneralInfoOk200;

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

  it('a ROTA publica os dois ramos — não basta a constante existir', () => {
    // Esta é a asserção que a sabotagem S4 derrubaria. Ela lê o documento
    // OpenAPI GERADO, que é o que vira cliente, e não o schema solto.
    const doc = buildOpenApiDocument() as unknown as Record<string, any>;
    const schema = doc.paths['/api/workers/me/general-info'].put.responses['200']
      .content['application/json'].schema;

    // O 200 tem de declarar OS DOIS ramos.
    expect(schema.anyOf).toHaveLength(2);
    const refs = (schema.anyOf as Array<{ $ref?: string }>).map((r) => r.$ref);
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('WorkerProfile'),
        expect.stringContaining('UnconfirmedWrite'),
      ]),
    );
  });

  it('a rota declara 409 e 404, que ela comprovadamente devolve', () => {
    const doc = buildOpenApiDocument() as unknown as Record<string, any>;
    const responses = doc.paths['/api/workers/me/general-info'].put.responses;
    expect(Object.keys(responses).sort()).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '409', '500']),
    );
  });

  it('a chave missingFields é OBRIGATÓRIA — sem terceiro estado', () => {
    // Se ela virar `.optional()`, um cliente gerado ganha `undefined` além de
    // `[]` e `null`, e `if (!missingFields?.length)` volta a chamar de completo
    // quem não foi apurado. É a D302 renascendo pela spec.
    const semAChave = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ana@example.com',
      status: 'REGISTERED',
    };
    expect(OK_200.safeParse(semAChave).success).toBe(false);
  });

  it('o instrumento enxerga: um objeto que não é nenhum dos dois ramos REPROVA', () => {
    // Contagem/aprovação no vácuo: sem este caso, um schema frouxo passaria em
    // tudo acima e o teste viraria decoração.
    expect(OK_200.safeParse({ foo: 'bar' }).success).toBe(false);
    expect(OK_200.safeParse({ message: 'ok' }).success).toBe(false);
  });
});
