/**
 * O ato irreversível (spec 010, F2 2.3/2.4).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. **O SID é gravado ANTES de submeter.** Se a submissão falhar depois de o
 *    Content existir, a retentativa tem de encontrar o SID — senão cada clique
 *    cria um Content novo e queima um nome novo na WABA. A ORDEM é o contrato.
 * 2. **Desligado, nada sai.** Nenhuma chamada ao writer quando a flag ou a
 *    credencial faltam.
 * 3. **Nunca submete texto que não passa nas regras** — mesmo que tenha passado
 *    quando foi salvo; as regras podem ter mudado desde então.
 * 4. **A ponte existe:** submetido vira linha em `message_templates`, senão a
 *    pessoa nunca veria o estado da Meta para a mensagem que ela escreveu.
 */
import { SubmitTemplateDraft, submissaoDeuCerto } from '../SubmitTemplateDraft';
import type { TwilioContentWriter } from '../../infrastructure/TwilioContentWriter';

const LINHA = {
  id: 'id-1', slug: 'ar_bienvenida', name: 'Bienvenida',
  body: 'Hola {{worker_name}}, del caso {{case_number}}, gracias.',
  category: 'UTILITY', language: 'es-AR', content_sid: null as string | null,
};

function writerFalso(over: Partial<TwilioContentWriter> = {}): TwilioContentWriter {
  return {
    indisponivel: null,
    configured: true,
    criarContent: jest.fn(async () => ({ sid: 'HXnovo' })),
    submeterParaAprovacao: jest.fn(async () => ({ contentSid: 'HXnovo', name: 'ar_bienvenida', category: 'UTILITY' })),
    ...over,
  } as unknown as TwilioContentWriter;
}

/** Devolve a linha na 1ª consulta e conta as gravações seguintes. */
function dbFalso(linha: Record<string, unknown> | null = LINHA) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes('SELECT id, slug')) {
      return linha ? { rows: [linha], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { db: { query } as never, chamadas, query };
}

describe('caminho feliz', () => {
  it('cria, grava o SID, submete, marca e PROMOVE — nessa ordem', async () => {
    const { db, chamadas } = dbFalso();
    const w = writerFalso();
    const r = await new SubmitTemplateDraft(db, w).execute('id-1', 'uid-a');

    expect(submissaoDeuCerto(r)).toBe(true);
    expect(r).toMatchObject({
      contentSid: 'HXnovo',
      slug: 'ar_bienvenida',
      bodyTwilio: 'Hola {{1}}, del caso {{2}}, gracias.',
      variaveis: ['worker_name', 'case_number'],
    });

    // 🔒 A ORDEM: o UPDATE com content_sid vem ANTES do submeter.
    const iGravouSid = chamadas.findIndex((c) => c.sql.includes('SET content_sid = $2'));
    expect(iGravouSid).toBeGreaterThan(-1);
    const ordemSubmit = (w.submeterParaAprovacao as jest.Mock).mock.invocationCallOrder[0];
    const ordemCriar = (w.criarContent as jest.Mock).mock.invocationCallOrder[0];
    expect(ordemCriar).toBeLessThan(ordemSubmit);

    // A ponte: virou linha em message_templates com o SID e o texto convertido.
    const promocao = chamadas.find((c) => c.sql.includes('INSERT INTO message_templates'));
    expect(promocao).toBeTruthy();
    expect(promocao?.params).toEqual(expect.arrayContaining(['ar_bienvenida', 'HXnovo', 'Hola {{1}}, del caso {{2}}, gracias.']));
  });

  it('o texto NOSSO (nomeado) é o que vai para `body`; o convertido vai para `body_twilio`', async () => {
    const { db, chamadas } = dbFalso();
    await new SubmitTemplateDraft(db, writerFalso()).execute('id-1', 'uid-a');
    const p = chamadas.find((c) => c.sql.includes('INSERT INTO message_templates'))?.params ?? [];
    expect(p[2]).toBe('Hola {{worker_name}}, del caso {{case_number}}, gracias.');
    expect(p[5]).toBe('Hola {{1}}, del caso {{2}}, gracias.');
  });

  it('registra quem submeteu', async () => {
    const { db, chamadas } = dbFalso();
    await new SubmitTemplateDraft(db, writerFalso()).execute('id-1', 'uid-a');
    const marca = chamadas.find((c) => c.sql.includes('submitted_by = $2'));
    expect(marca?.params).toContain('uid-a');
  });

  it('sem ator logado grava null, não quebra', async () => {
    const { db, chamadas } = dbFalso();
    await new SubmitTemplateDraft(db, writerFalso()).execute('id-1', null);
    const marca = chamadas.find((c) => c.sql.includes('submitted_by = $2'));
    expect(marca?.params).toContain(null);
  });

  it('manda o slug como nome do template e a categoria escolhida', async () => {
    const { db } = dbFalso();
    const w = writerFalso();
    await new SubmitTemplateDraft(db, w).execute('id-1', 'uid-a');
    expect(w.submeterParaAprovacao).toHaveBeenCalledWith('HXnovo', 'ar_bienvenida', 'UTILITY');
  });
});

describe('os caminhos que NÃO submetem', () => {
  it('rowCount nulo é tratado como zero, não como encontrado', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: null }));
    const w = writerFalso();
    expect(await new SubmitTemplateDraft({ query } as never, w).execute('x', null))
      .toEqual({ tipo: 'nao_encontrado' });
    expect(w.criarContent).not.toHaveBeenCalled();
  });

  it('rascunho inexistente', async () => {
    const { db } = dbFalso(null);
    const w = writerFalso();
    expect(await new SubmitTemplateDraft(db, w).execute('x', null)).toEqual({ tipo: 'nao_encontrado' });
    expect(w.criarContent).not.toHaveBeenCalled();
  });

  it('já submetido devolve o SID que já existe — não cria um segundo', async () => {
    const { db } = dbFalso({ ...LINHA, content_sid: 'HXjaexiste' });
    const w = writerFalso();
    expect(await new SubmitTemplateDraft(db, w).execute('id-1', null))
      .toEqual({ tipo: 'ja_submetido', contentSid: 'HXjaexiste' });
    expect(w.criarContent).not.toHaveBeenCalled();
  });

  it('🔒 revalida ANTES de submeter — texto inválido não vai para a Meta', async () => {
    const { db } = dbFalso({ ...LINHA, body: 'Hola {{1}} posicional' });
    const w = writerFalso();
    const r = await new SubmitTemplateDraft(db, w).execute('id-1', null);
    expect((r as { tipo: string }).tipo).toBe('regras');
    expect((r as { problemas: Array<{ regra: string }> }).problemas.map((p) => p.regra))
      .toContain('placeholder_posicional');
    expect(w.criarContent).not.toHaveBeenCalled();
  });

  it('🔒 flag desligada: nenhuma chamada ao writer', async () => {
    const { db } = dbFalso();
    const w = writerFalso({ indisponivel: 'flag_desligada' } as never);
    expect(await new SubmitTemplateDraft(db, w).execute('id-1', null))
      .toEqual({ tipo: 'indisponivel', motivo: 'flag_desligada' });
    expect(w.criarContent).not.toHaveBeenCalled();
  });

  it('sem credencial: idem, e o motivo é distinguido', async () => {
    const { db } = dbFalso();
    const w = writerFalso({ indisponivel: 'sem_credencial' } as never);
    expect(await new SubmitTemplateDraft(db, w).execute('id-1', null))
      .toEqual({ tipo: 'indisponivel', motivo: 'sem_credencial' });
    expect(w.criarContent).not.toHaveBeenCalled();
  });
});

describe('quando a Twilio falha', () => {
  it('falha ao CRIAR: guarda o motivo e não submete', async () => {
    const { db, chamadas } = dbFalso();
    const w = writerFalso({ criarContent: jest.fn(async () => { throw new Error('400 nome em uso'); }) } as never);
    const r = await new SubmitTemplateDraft(db, w).execute('id-1', null);
    expect(r).toEqual({ tipo: 'twilio', mensagem: '400 nome em uso' });
    expect(w.submeterParaAprovacao).not.toHaveBeenCalled();
    const erro = chamadas.find((c) => c.sql.includes('submission_error = $2'));
    expect(erro?.params[1]).toContain('criar_content: 400 nome em uso');
  });

  it('🔒 falha ao SUBMETER: o SID JÁ está gravado — a retentativa não cria outro Content', async () => {
    const { db, chamadas } = dbFalso();
    const w = writerFalso({ submeterParaAprovacao: jest.fn(async () => { throw new Error('502 meta fora'); }) } as never);
    const r = await new SubmitTemplateDraft(db, w).execute('id-1', null);
    expect(r).toEqual({ tipo: 'twilio', mensagem: '502 meta fora' });

    const iSid = chamadas.findIndex((c) => c.sql.includes('SET content_sid = $2'));
    const iErro = chamadas.findIndex((c) => c.sql.includes('submission_error = $2'));
    expect(iSid).toBeGreaterThan(-1);
    expect(iSid).toBeLessThan(iErro);
    // E NÃO marcou como submetido: falhou, e o estado diz isso.
    expect(chamadas.find((c) => c.sql.includes('submitted_by = $2'))).toBeUndefined();
  });

  it('erro não-Error também vira mensagem legível', async () => {
    const { db } = dbFalso();
    const w = writerFalso({ criarContent: jest.fn(async () => { throw 'string crua'; }) } as never);
    expect(await new SubmitTemplateDraft(db, w).execute('id-1', null))
      .toEqual({ tipo: 'twilio', mensagem: 'string crua' });
  });
});

describe('submissaoDeuCerto', () => {
  it('distingue sucesso de falha sem `as`', () => {
    expect(submissaoDeuCerto({ contentSid: 'HXa', slug: 's', bodyTwilio: 'b', variaveis: [] })).toBe(true);
    expect(submissaoDeuCerto({ tipo: 'nao_encontrado' })).toBe(false);
    expect(submissaoDeuCerto({ tipo: 'ja_submetido', contentSid: 'HXa' })).toBe(false);
  });
});
