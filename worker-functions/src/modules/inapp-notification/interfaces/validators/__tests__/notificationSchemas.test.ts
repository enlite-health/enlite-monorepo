/**
 * notificationSchemas — TDD (spec 022, Bloco 4).
 *
 * Achado do gate revisao-pr (B4): os schemas de query/params das rotas do sino
 * (`AdminNotificationController.ts:43,73`, `perm.require('own_notifications', ...)`) nunca
 * tinham teste unitário de "query inválida" (400) — só cobertos IMPLICITAMENTE pelos e2e, que só
 * exercitam a query VÁLIDA (`tests/e2e/notifications/adminNotifications.e2e.test.ts`). Cobertura
 * 0% de linhas no jest (arquivo pequeno, só schema) — este arquivo fecha isso, RED-first: cada
 * `it` de rejeição prova que `.safeParse` devolve `success: false` para o formato que a régua
 * (Zod) tem que barrar ANTES do controller/use case rodar.
 */
import { listNotificationsQuerySchema, notificationIdParamsSchema } from '../notificationSchemas';

describe('listNotificationsQuerySchema (GET /api/admin/notifications, query)', () => {
  it('aceita query vazia: limit cai no default (20), unread ausente', () => {
    const r = listNotificationsQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(20);
      expect(r.data.unread).toBeUndefined();
    }
  });

  it('aceita limit dentro do intervalo (1..50), coagido de string pra número', () => {
    const r = listNotificationsQuerySchema.safeParse({ limit: '30' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(30);
  });

  it('aceita unread="1" (único valor literal permitido)', () => {
    const r = listNotificationsQuerySchema.safeParse({ unread: '1' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.unread).toBe('1');
  });

  it.each([
    ['0 — abaixo do mínimo (1)', { limit: '0' }],
    ['51 — acima do máximo (50)', { limit: '51' }],
    ['negativo', { limit: '-5' }],
    ['não numérico', { limit: 'abc' }],
    ['decimal (não inteiro)', { limit: '20.5' }],
  ])('🔒 400: limit=%s é rejeitado', (_label, query) => {
    const r = listNotificationsQuerySchema.safeParse(query);
    expect(r.success).toBe(false);
  });

  it.each([
    ['"0" — só "1" é aceito', { unread: '0' }],
    ['"true" — não é o literal esperado', { unread: 'true' }],
    ['string qualquer', { unread: 'yes' }],
  ])('🔒 400: unread=%s é rejeitado (literal "1", não boolean coagido)', (_label, query) => {
    const r = listNotificationsQuerySchema.safeParse(query);
    expect(r.success).toBe(false);
  });
});

describe('notificationIdParamsSchema (POST /api/admin/notifications/:id/read, params)', () => {
  it('aceita um uuid válido', () => {
    const r = notificationIdParamsSchema.safeParse({ id: '11111111-1111-1111-1111-111111111111' });
    expect(r.success).toBe(true);
  });

  it.each([
    ['string qualquer, não uuid', { id: 'not-a-uuid' }],
    ['uuid mal formado (segmento curto)', { id: '1111-1111-1111-1111-111111111111' }],
    ['vazio', { id: '' }],
    ['ausente', {}],
    ['numérico', { id: 12345 }],
  ])('🔒 400: id=%s é rejeitado', (_label, params) => {
    const r = notificationIdParamsSchema.safeParse(params);
    expect(r.success).toBe(false);
  });
});
