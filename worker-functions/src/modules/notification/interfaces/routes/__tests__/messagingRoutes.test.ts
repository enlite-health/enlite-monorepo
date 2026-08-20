/**
 * Família `admin.messaging` (task 3.5-A4): 7 rotas, TRÊS células — e a separação
 * é o conteúdo deste teste, não um detalhe dele.
 *
 * O mapa da 0.6 dava `messaging:send` também ao CRUD de template. Cada linha de
 * `message_templates` amarra um `slug` a um `content_sid` — o HSM aprovado pela
 * Meta — e é ele que o envio usa. Com uma célula só, quem pode disparar reescreve
 * o texto que todo mundo dispara. Decisão do Gabriel (20/08): separar.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createMessagingRoutes, ADMIN_MESSAGING_FAMILY } from '../messagingRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** O controller REAL é construído dentro da fábrica — só as deps entram. */
jest.mock('../../controllers/MessagingController', () => ({
  MessagingController: jest.fn().mockImplementation(() => {
    const marca =
      (nome: string) => (req: express.Request, res: express.Response) =>
        res.json({ m: nome, slug: req.params.slug });
    return {
      sendVacancyMatch: marca('sendVacancyMatch'),
      sendDirect: marca('sendDirect'),
      listTemplates: marca('listTemplates'),
      createTemplate: marca('createTemplate'),
      updateTemplate: marca('updateTemplate'),
      deleteTemplate: marca('deleteTemplate'),
      bulkDispatchIncomplete: marca('bulkDispatchIncomplete'),
    };
  }),
}));

/** Mapa esperado — o CORRIGIDO, com `messaging:write` no CRUD de template. */
const ESPERADO: Record<string, string> = {
  'POST /whatsapp/vacancy-match': 'messaging:send',
  'POST /whatsapp/direct': 'messaging:send',
  'GET /templates': 'messaging:read',
  'POST /templates': 'messaging:write',
  'PUT /templates/:slug': 'messaging:write',
  'DELETE /templates/:slug': 'messaging:write',
  'POST /bulk-dispatch-incomplete': 'messaging:send',
};

function build(): express.Router {
  return createMessagingRoutes({} as never, {} as never, permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.messaging — 7 rotas, 3 células', () => {
  it('a família é `admin.messaging` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_MESSAGING_FAMILY).toBe('admin.messaging');
  });

  it('cada rota declara a célula do mapa (corrigido no A4)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 7 rotas — a conta que saiu do PENDING_DECLARATIONS', () => {
    expect(scanExpressRouter(build())).toHaveLength(7);
  });

  /**
   * O caso que este PR existe para travar: se alguém "simplificar" as três
   * células em uma, este teste fica vermelho apontando exatamente onde.
   */
  it('ESCREVER template é messaging:write — NÃO messaging:send', () => {
    for (const rota of ['POST /templates', 'PUT /templates/:slug', 'DELETE /templates/:slug']) {
      expect(declaradas()[rota]).toBe('messaging:write');
    }
  });

  it('DISPARAR é messaging:send, e LISTAR template é messaging:read', () => {
    for (const rota of ['POST /whatsapp/vacancy-match', 'POST /whatsapp/direct', 'POST /bulk-dispatch-incomplete']) {
      expect(declaradas()[rota]).toBe('messaging:send');
    }
    expect(declaradas()['GET /templates']).toBe('messaging:read');
  });

  it('nenhuma rota de ENVIO usa a célula de escrita, e nenhuma de escrita usa a de envio', () => {
    const porCelula = Object.entries(declaradas()).reduce<Record<string, string[]>>((acc, [rota, celula]) => {
      (acc[celula ?? 'sem'] ??= []).push(rota);
      return acc;
    }, {});
    expect(porCelula['messaging:send'].every((r) => r.includes('whatsapp') || r.includes('bulk'))).toBe(true);
    expect(porCelula['messaging:write'].every((r) => r.includes('/templates'))).toBe(true);
  });

  it.each([
    ['post', '/api/admin/messaging/whatsapp/vacancy-match', 'sendVacancyMatch'],
    ['post', '/api/admin/messaging/whatsapp/direct', 'sendDirect'],
    ['get', '/api/admin/messaging/templates', 'listTemplates'],
    ['post', '/api/admin/messaging/templates', 'createTemplate'],
    ['put', '/api/admin/messaging/templates/abc', 'updateTemplate'],
    ['delete', '/api/admin/messaging/templates/abc', 'deleteTemplate'],
    ['post', '/api/admin/messaging/bulk-dispatch-incomplete', 'bulkDispatchIncomplete'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/api/admin/messaging', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });
});
