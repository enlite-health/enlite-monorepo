/**
 * O passo que grava o estado da Meta, SEPARADO do plano de insert/update/delete.
 *
 * A separação é a decisão (c) do Gabriel em 31/08: gravar o estado não pode
 * mudar o que o sync apaga. `collectApprovedTwilio` e `computePlan` ficam
 * intocados; este passo só escreve as colunas `meta_approval_*`.
 */
import { runMetaStatusStep, describeMetaStatusStep } from '../meta-status-step';

const providerFake = (over: Record<string, unknown> = {}) =>
  ({
    configured: true,
    syncStatuses: jest.fn(async () => ({
      fetched: 27, matched: 27, withoutContentSid: [], unknownToUs: [], unknownStatuses: [],
    })),
    ...over,
  }) as never;

describe('runMetaStatusStep', () => {
  it('em dry-run NÃO escreve — só diz o que faria', async () => {
    const p = providerFake();
    const r = await runMetaStatusStep(p, { apply: false });
    expect((p as unknown as { syncStatuses: jest.Mock }).syncStatuses).not.toHaveBeenCalled();
    expect(r.skipped).toBe('dry-run');
  });

  it('com --apply grava e devolve o que foi lido', async () => {
    const r = await runMetaStatusStep(providerFake(), { apply: true });
    expect(r.result).toMatchObject({ fetched: 27, matched: 27 });
    expect(r.skipped).toBeNull();
  });

  it('sem credencial: pula e diz por quê, sem explodir', async () => {
    const r = await runMetaStatusStep(providerFake({ configured: false }), { apply: true });
    expect(r.skipped).toBe('sem-credencial');
  });

  it('falha da Meta NAO derruba o sync — o trabalho principal e Twilio->banco', async () => {
    const p = providerFake({ syncStatuses: jest.fn(async () => { throw new Error('Meta Graph 500'); }) });
    const r = await runMetaStatusStep(p, { apply: true });
    expect(r.error).toMatch(/Meta Graph 500/);
    expect(r.result).toBeNull();
  });

  it('lançar algo que não é Error também vira mensagem, não crash', async () => {
    const p = providerFake({ syncStatuses: jest.fn(async () => { throw 'string crua'; }) });
    const r = await runMetaStatusStep(p, { apply: true });
    expect(r.error).toBe('string crua');
  });

  it('o que nao casou volta NOMEADO, nao so contado', async () => {
    const p = providerFake({
      syncStatuses: jest.fn(async () => ({
        fetched: 3, matched: 1, withoutContentSid: ['criado_na_meta'], unknownToUs: ['HXzzz'], unknownStatuses: ['ALGO_NOVO'],
      })),
    });
    const r = await runMetaStatusStep(p, { apply: true });
    expect(r.result?.withoutContentSid).toEqual(['criado_na_meta']);
    expect(r.result?.unknownStatuses).toEqual(['ALGO_NOVO']);
  });
});

describe('describeMetaStatusStep — imprime a LISTA, não só a contagem', () => {
  const base = { result: null, skipped: null, error: null } as never;
  const comResultado = (over: Record<string, unknown>) => ({
    ...(base as object),
    result: { fetched: 27, matched: 27, withoutContentSid: [], unknownToUs: [], unknownStatuses: [], ...over },
  }) as never;

  it('dry-run diz que não gravou', () => {
    expect(describeMetaStatusStep({ ...(base as object), skipped: 'dry-run' } as never)[0]).toMatch(/dry-run/);
  });

  it('sem credencial nomeia as variáveis que faltam', () => {
    expect(describeMetaStatusStep({ ...(base as object), skipped: 'sem-credencial' } as never)[0]).toMatch(/WABA_ID/);
  });

  it('erro diz que o sync seguiu — não parece falha total', () => {
    const l = describeMetaStatusStep({ ...(base as object), error: 'boom' } as never)[0];
    expect(l).toMatch(/boom/);
    expect(l).toMatch(/seguiu/);
  });

  it('caso limpo: uma linha só', () => {
    expect(describeMetaStatusStep(comResultado({}))).toHaveLength(1);
  });

  it('nomeia quem não nasceu na Twilio', () => {
    const l = describeMetaStatusStep(comResultado({ withoutContentSid: ['criado_na_meta'] }));
    expect(l.join(' ')).toContain('criado_na_meta');
  });

  it('nomeia o SID que o banco não conhece', () => {
    expect(describeMetaStatusStep(comResultado({ unknownToUs: ['HXzzz'] })).join(' ')).toContain('HXzzz');
  });

  it('nomeia o estado fora dos 10 e diz que gravou assim mesmo', () => {
    const l = describeMetaStatusStep(comResultado({ unknownStatuses: ['ALGO_NOVO'] })).join(' ');
    expect(l).toContain('ALGO_NOVO');
    expect(l).toMatch(/assim mesmo/);
  });

  it('resultado ausente não quebra', () => {
    expect(describeMetaStatusStep(base)[0]).toMatch(/sem resultado/);
  });
});
