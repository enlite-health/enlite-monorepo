/**
 * O contrato do catálogo. O que estes testes protegem, em ordem de importância:
 *
 * 1. `bodyTwilio` é o único texto exposto. `body` NÃO sai na resposta — ele é
 *    contrato de envio e divergiu do aprovado em 12 de 27 templates (mig 295).
 * 2. Estado da Meta e elegibilidade são campos SEPARADOS: APPROVED + inelegível
 *    é um caso real (posicionais), e juntar os dois esconderia isso.
 * 3. Nenhum estado é inventado: nunca verificado devolve null, não "pendente".
 */
import type { Request, Response } from 'express';
import { TemplateCatalogController } from '../TemplateCatalogController';

const linha = (over: Record<string, unknown> = {}) => ({
  slug: 'ar_bienvenida', name: 'ar_bienvenida',
  body: 'Hola {{worker_name}}', body_twilio: 'Hola {{1}}',
  category: 'UTILITY', is_active: true, content_sid: 'HXaaa',
  meta_approval_status: 'APPROVED', meta_approval_reason: null,
  meta_approval_detail: null, meta_approval_checked_at: '2026-08-31T12:00:00Z',
  used_in_stages: ['HIRED'], ...over,
});

const run = async (rows: unknown[]) => {
  const db = { query: jest.fn(async () => ({ rows })) } as never;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
  await new TemplateCatalogController(db).list({} as Request, res);
  return { res, body: (res.json as jest.Mock).mock.calls[0]?.[0] };
};

describe('construção', () => {
  it('sem pool injetado pega o do singleton — o fio padrão está ligado', () => {
    const pool = { query: jest.fn() };
    jest.doMock('@shared/database/DatabaseConnection', () => ({
      DatabaseConnection: { getInstance: () => ({ getPool: () => pool }) },
    }));
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TemplateCatalogController: C } = require('../TemplateCatalogController');
      expect(new C()).toBeInstanceOf(C);
    });
  });
});

describe('TemplateCatalogController.list', () => {
  it('devolve o texto APROVADO e não expõe o contrato de envio', async () => {
    const { body } = await run([linha()]);
    const t = body.data.templates[0];
    expect(t.bodyTwilio).toBe('Hola {{1}}');
    expect(t).not.toHaveProperty('body');
  });

  it('estado da Meta e elegibilidade são campos separados', async () => {
    const { body } = await run([linha()]);
    const t = body.data.templates[0];
    expect(t.metaStatus).toBe('APPROVED');
    expect(t).toHaveProperty('eligible');
  });

  it('APROVADO na Meta e INELEGÍVEL para etapa convivem — o caso dos posicionais', async () => {
    const { body } = await run([linha({ body: 'Hola {{1}} en {{2}}', body_twilio: 'Hola {{1}} en {{2}}' })]);
    const t = body.data.templates[0];
    expect(t.metaStatus).toBe('APPROVED');
    expect(t.eligible).toBe(false);
    expect(t.ineligibleReason).toBeTruthy();
  });

  it('nunca verificado devolve null — não inventa "pendente"', async () => {
    const { body } = await run([linha({ meta_approval_status: null, meta_approval_checked_at: null })]);
    expect(body.data.templates[0].metaStatus).toBeNull();
    expect(body.data.templates[0].metaCheckedAt).toBeNull();
  });

  it('carrega motivo e explicação da recusa quando existem', async () => {
    const { body } = await run([linha({
      meta_approval_status: 'REJECTED', meta_approval_reason: 'INVALID_FORMAT',
      meta_approval_detail: 'Parâmetros colados um no outro.',
    })]);
    const t = body.data.templates[0];
    expect(t.metaReason).toBe('INVALID_FORMAT');
    expect(t.metaDetail).toMatch(/colados/);
  });

  it('PAUSED aparece — é o estado que sumia', async () => {
    const { body } = await run([linha({ meta_approval_status: 'PAUSED' })]);
    expect(body.data.templates[0].metaStatus).toBe('PAUSED');
  });

  it('"usado em" vem como lista, e vazio é lista vazia e não null', async () => {
    const { body } = await run([linha(), linha({ slug: 'outro', used_in_stages: null })]);
    expect(body.data.templates[0].usedInStages).toEqual(['HIRED']);
    expect(body.data.templates[1].usedInStages).toEqual([]);
  });

  it('template inativo continua aparecendo — some da lista é o defeito, não a feature', async () => {
    const { body } = await run([linha({ is_active: false })]);
    expect(body.data.templates).toHaveLength(1);
    expect(body.data.templates[0].isActive).toBe(false);
  });

  it('catálogo vazio devolve lista vazia com sucesso', async () => {
    const { res, body } = await run([]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(body.data.templates).toEqual([]);
  });

  it('falha do banco vira 500 sem vazar detalhe', async () => {
    const db = { query: jest.fn(async () => { throw new Error('senha=segredo'); }) } as never;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    await new TemplateCatalogController(db).list({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify((res.json as jest.Mock).mock.calls[0][0])).not.toContain('segredo');
  });

  it('erro que não é Error também vira 500', async () => {
    const db = { query: jest.fn(async () => { throw 'string crua'; }) } as never;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    await new TemplateCatalogController(db).list({} as Request, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
