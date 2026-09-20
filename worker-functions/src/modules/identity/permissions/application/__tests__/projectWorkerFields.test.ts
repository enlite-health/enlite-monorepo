/**
 * A condição C3 do `lex` não é "o campo não aparece na resposta" — é
 * **`kms.decrypt` não roda**. Redigir depois de descriptografar é esconder da
 * tela: o texto claro já existiu em memória, já pôde entrar num stack trace do
 * KMS e já pôde cair num log.
 *
 * Por isso a asserção central aqui é sobre o ESPIÃO, com zero chamadas — e não
 * sobre o objeto devolvido. Um teste que só olhasse a saída passaria com a
 * implementação errada.
 */

import {
  projectWorkerFields,
  NOME_REDIGIDO,
  CELL_WORKER_CONTACT_READ,
  CELL_WORKER_PII_READ,
  type WorkerRow,
  ProjecaoSemDecryptorError,
} from '../projectWorkerFields';

const LINHA: WorkerRow = {
  id: 'w-1',
  status: 'ACTIVE',
  occupation: 'ENFERMERA',
  workZone: 'CABA',
  stage: 'COMPLETED',
  firstNameEncrypted: 'enc:María',
  lastNameEncrypted: 'enc:González',
  phone: '+5491133445566',
  whatsappPhoneEncrypted: 'enc:+5491199887766',
  email: 'maria@exemplo.test',
  documentNumberEncrypted: 'enc:34.222.111',
  birthDateEncrypted: 'enc:1984-03-02',
  addressEncrypted: 'enc:Av. Corrientes 1234',
  profilePhotoUrlEncrypted: 'enc:https://foto',
  race: 'parda',
  religion: 'católica',
  sexualOrientation: 'heterossexual',
};

/** Devolve o texto depois do `enc:` — e CONTA cada chamada. */
function espiao() {
  const decrypt = jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, ''));
  return { kms: { decrypt }, decrypt };
}

describe('projectWorkerFields — a célula decide ANTES do KMS', () => {
  it('sem worker_contact:read, o KMS NÃO RODA — zero chamadas', async () => {
    const { kms, decrypt } = espiao();

    const out = await projectWorkerFields(['worker:read'], LINHA, kms);

    expect(decrypt).toHaveBeenCalledTimes(0);
    expect(out.name).toBe(NOME_REDIGIDO);
    expect(out.phone).toBeUndefined();
  });

  it('com contato mas SEM dossiê, o KMS roda só nos campos de contato', async () => {
    const { kms, decrypt } = espiao();

    const out = await projectWorkerFields(['worker:read', CELL_WORKER_CONTACT_READ], LINHA, kms);

    // 3 = nome, sobrenome, whatsapp. Nenhum campo de dossiê foi tocado.
    expect(decrypt).toHaveBeenCalledTimes(3);
    const abertos = decrypt.mock.calls.map((c) => String(c[0]));
    expect(abertos).toEqual(['enc:María', 'enc:González', 'enc:+5491199887766']);
    expect(out.name).toBe('María González');
    expect(out.documentNumber).toBeUndefined();
  });

  it('o DOSSIÊ nunca atravessa sem worker_pii:read — nem cru, nem aberto', async () => {
    const { kms } = espiao();

    const out = await projectWorkerFields(['worker:read', CELL_WORKER_CONTACT_READ], LINHA, kms);

    // Guarda pela FRONTEIRA: olha TUDO que sai, não a lista de campos que
    // alguém lembrou de checar.
    const tudo = JSON.stringify(out).toLowerCase();
    for (const proibido of ['34.222.111', '1984-03-02', 'corrientes', 'parda', 'católica', 'heterossexual']) {
      expect(tudo).not.toContain(proibido.toLowerCase());
    }
  });

  it('com as duas células, o dossiê abre — e o KMS roda 7 vezes, não mais', async () => {
    const { kms, decrypt } = espiao();

    const out = await projectWorkerFields(
      ['worker:read', CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ],
      LINHA,
      kms,
    );

    expect(decrypt).toHaveBeenCalledTimes(7);
    expect(out.documentNumber).toBe('34.222.111');
    expect(out.race).toBe('parda');
    expect(out.name).toBe('María González');
  });

  it('ator SEM nenhuma célula (`[]`) não é o mesmo que engine desligado (`null`)', async () => {
    const semNada = espiao();
    const semEngine = espiao();

    const a = await projectWorkerFields([], LINHA, semNada.kms);
    const b = await projectWorkerFields(null, LINHA, semEngine.kms);

    expect(semNada.decrypt).toHaveBeenCalledTimes(0);
    expect(a.name).toBe(NOME_REDIGIDO);

    // `null` = o engine não decidiu nesta request; o rollout exige que nada mude.
    expect(semEngine.decrypt).toHaveBeenCalledTimes(7);
    expect(b.name).toBe('María González');
    expect(b.race).toBe('parda');
  });

  it('o operacional sai nos três casos — redigir contato não pode apagar o funil', async () => {
    const { kms } = espiao();
    const out = await projectWorkerFields([], LINHA, kms);
    expect(out).toMatchObject({
      id: 'w-1',
      status: 'ACTIVE',
      occupation: 'ENFERMERA',
      workZone: 'CABA',
      stage: 'COMPLETED',
    });
  });

  it('KMS caindo não derruba a listagem — o campo vira null, o resto sai', async () => {
    const decrypt = jest.fn(async () => {
      throw new Error('KMS fora do ar');
    });

    const out = await projectWorkerFields([CELL_WORKER_CONTACT_READ], LINHA, { decrypt });

    expect(out.name).toBeNull();
    expect(out.phone).toBe('+5491133445566');
    expect(out.status).toBe('ACTIVE');
  });

  it('nome em TEXTO CLARO (`rawName`) obedece à mesma célula — não escapa por não custar KMS', async () => {
    const { kms, decrypt } = espiao();
    const legado: WorkerRow = { id: 'w-3', rawName: 'Carlos Legado' };

    const redigido = await projectWorkerFields([], legado, kms);
    const aberto = await projectWorkerFields([CELL_WORKER_CONTACT_READ], legado, kms);

    // Zero chamadas nos dois casos: não há cifra nenhuma nesta linha. É
    // exatamente por isso que o espião NÃO basta aqui, e a fronteira é a prova.
    expect(decrypt).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(redigido)).not.toContain('Carlos Legado');
    expect(redigido.name).toBe(NOME_REDIGIDO);
    expect(aberto.name).toBe('Carlos Legado');
  });

  it('o cifrado ganha do texto claro quando os dois existem', async () => {
    const { kms } = espiao();
    const out = await projectWorkerFields(
      [CELL_WORKER_CONTACT_READ],
      { ...LINHA, rawName: 'Nome Antigo Do Import' },
      kms,
    );
    expect(out.name).toBe('María González');
  });

  it('KMS que devolve VAZIO vira `null`, não string vazia', async () => {
    // O piso do módulo é 100% de branch (jest.config.js): este ramo de `abrir()`
    // é a diferença entre `name: null` e `name: ' '` — o `filter(Boolean)` do
    // nome depende dele. Cifra que decripta para vazio existe (campo gravado em
    // branco antes da 023), e a tela não pode receber um nome de um espaço só.
    const decrypt = jest.fn(async () => '');
    const out = await projectWorkerFields(
      [CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ],
      LINHA,
      { decrypt },
    );

    expect(decrypt).toHaveBeenCalledTimes(7);
    expect(out.name).toBeNull();
    expect(out.whatsappPhone).toBeNull();
    expect(out.documentNumber).toBeNull();
    expect(out.birthDate).toBeNull();
    expect(out.address).toBeNull();
    expect(out.profilePhotoUrl).toBeNull();
  });

  it('dossiê em texto claro AUSENTE vira `null`, não `undefined`', async () => {
    // `race`/`religion`/`sexualOrientation` são as únicas colunas do dossiê que
    // não são cifradas. O ramo `?? null` delas só existe quando a linha vem sem
    // elas — que é o caso de todo prestador que não respondeu.
    const { kms } = espiao();
    const out = await projectWorkerFields(
      [CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ],
      { id: 'w-4' },
      kms,
    );

    expect(out.race).toBeNull();
    expect(out.religion).toBeNull();
    expect(out.sexualOrientation).toBeNull();
  });

  it('campo cifrado vazio não vira chamada de KMS — não se paga por nada', async () => {
    const { kms, decrypt } = espiao();

    await projectWorkerFields([CELL_WORKER_CONTACT_READ], { id: 'w-2', firstNameEncrypted: '' }, kms);

    expect(decrypt).toHaveBeenCalledTimes(0);
  });

  describe('ProjecaoSemDecryptorError — erro de programação NÃO se degrada (ALTO do gate)', () => {
    const linha = { firstNameEncrypted: 'cifra-que-nao-deveria-existir-nesta-rota' } as never;

    it('🔴 sentinela ATRAVESSA o `catch` — a promessa "falhar alto" passa a valer', async () => {
      const semKms = {
        decrypt: async () => {
          throw new ProjecaoSemDecryptorError('esta rota não descriptografa');
        },
      };

      await expect(projectWorkerFields(null, linha, semKms)).rejects.toBeInstanceOf(ProjecaoSemDecryptorError);
    });

    it('falha de RUNTIME do KMS continua degradando — oscilação não derruba o Kanban', async () => {
      const kmsCaiu = {
        decrypt: async () => {
          throw new Error('KMS: DEADLINE_EXCEEDED');
        },
      };

      const projetada = await projectWorkerFields(null, linha, kmsCaiu);

      expect(projetada).toBeDefined();
    });
  });
});
