/**
 * A escrita do painel (F4) — a BORDA. O que a autorização faz é assunto do e2e
 * (`permission-panel-write-abuse.e2e.test.ts`), porque ela mora no BANCO.
 *
 * Aqui se afirma: a declaração da célula em toda rota, o zod recusando antes de
 * qualquer ida ao banco, e o mapa erro-de-domínio → HTTP — que é o contrato que
 * a tela lê para saber se mostra "sem permissão", "nome repetido" ou "isso
 * deixaria a empresa sem gestor".
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes, PermissionError, ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { createPermissionPanelWriteRoutes, type PanelWriter } from '../permissionPanelWriteRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = '00000000-0000-0000-0000-000000000001';

/** Copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'POST /permission-groups': 'permission_management:write',
  'PATCH /permission-groups/:id': 'permission_management:write',
  'DELETE /permission-groups/:id': 'permission_management:write',
  'PUT /permission-groups/:id/permissions': 'permission_management:write',
  'POST /permission-groups/:id/countries': 'permission_management:write',
  'DELETE /permission-groups/:id/countries/:country': 'permission_management:write',
  'POST /permission-groups/:id/members': 'permission_management:write',
  'DELETE /permission-groups/:id/members': 'permission_management:write',
  'PUT /country-features/:country/:featureKey': 'permission_management:write',
};

type Dubles = Record<string, jest.Mock>;

function build(over: Dubles = {}, tenantId: string | undefined = TENANT) {
  const mk = (nome: string, valor: unknown = {}) =>
    over[nome] ?? jest.fn().mockResolvedValue(valor);
  const d: Dubles = {
    create: mk('create', { groupId: ID }),
    update: mk('update', undefined),
    archive: mk('archive', { affectedMembers: 0 }),
    setPermissions: mk('setPermissions', { cells: 2 }),
    grantCountry: mk('grantCountry', { scopeId: 'sc-1' }),
    revokeCountry: mk('revokeCountry', { revoked: 1 }),
    addMember: mk('addMember', { membershipId: 'm-1' }),
    removeMember: mk('removeMember', { removed: 1 }),
    setFeature: mk('setFeature', undefined),
  };
  const writer = {
    groups: {
      create: { execute: d.create }, update: { execute: d.update }, archive: { execute: d.archive },
      setPermissions: { execute: d.setPermissions }, grantCountry: { execute: d.grantCountry },
      revokeCountry: { execute: d.revokeCountry }, addMember: { execute: d.addMember },
      removeMember: { execute: d.removeMember },
    },
    features: { set: { execute: d.setFeature } },
  } as unknown as PanelWriter;

  const router = createPermissionPanelWriteRoutes({
    writer, auth: authDouble(), permissions: permissionsDouble(), tenantId,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', router);
  return { app, router, d };
}

describe('createPermissionPanelWriteRoutes — declaração', () => {
  it('TODA rota de escrita declara célula', () => {
    expect(undeclaredRoutes(scanExpressRouter(build().router), () => true)).toEqual([]);
  });

  it('🔴 as 9 rotas exigem `permission_management:write` — nenhuma escapa para `:read`', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build().router).map((r) => [
        `${r.method} ${r.path}`,
        r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('montadas em `/api/admin`, os caminhos são os que a lista dourada do inventário espera', () => {
    // O `permission-route-inventory.test.ts` lê o app pela REDE (binário do
    // container), então local ele não prova nada. Este caso prova aqui.
    const rotas = scanExpressRouter(build().app as never);

    expect(rotas.map((r) => `${r.method} ${r.path} → ${r.cell ? cellKey(r.cell.resource, r.cell.action) : null}`).sort()).toEqual([
      'DELETE /api/admin/permission-groups/:id → permission_management:write',
      'DELETE /api/admin/permission-groups/:id/countries/:country → permission_management:write',
      'DELETE /api/admin/permission-groups/:id/members → permission_management:write',
      'PATCH /api/admin/permission-groups/:id → permission_management:write',
      'POST /api/admin/permission-groups → permission_management:write',
      'POST /api/admin/permission-groups/:id/countries → permission_management:write',
      'POST /api/admin/permission-groups/:id/members → permission_management:write',
      'PUT /api/admin/country-features/:country/:featureKey → permission_management:write',
      'PUT /api/admin/permission-groups/:id/permissions → permission_management:write',
    ]);
  });

  it('sem `tenantId` injetado vale o da casa — o painel é mono-tenant hoje', async () => {
    // Construído à mão de propósito: passar `undefined` para o `build` acionaria
    // o DEFAULT do parâmetro e o teste mediria o caminho errado (caí nisso).
    const create = jest.fn().mockResolvedValue({ groupId: ID });
    const router = createPermissionPanelWriteRoutes({
      writer: {
        groups: {
          create: { execute: create }, update: { execute: jest.fn() }, archive: { execute: jest.fn() },
          setPermissions: { execute: jest.fn() }, grantCountry: { execute: jest.fn() },
          revokeCountry: { execute: jest.fn() }, addMember: { execute: jest.fn() },
          removeMember: { execute: jest.fn() },
        },
        features: { set: { execute: jest.fn() } },
      } as unknown as PanelWriter,
      auth: authDouble(),
      permissions: permissionsDouble(),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/admin', router);

    await request(app).post('/api/admin/permission-groups').send({ name: 'G' }).expect(200);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ENLITE_TENANT_ID }));
  });

  it('grupo sem descrição desce como `null`, não `undefined`', async () => {
    const { app, d } = build();

    await request(app).post('/api/admin/permission-groups').send({ name: 'Só nome' }).expect(200);

    expect(d.create).toHaveBeenCalledWith({ tenantId: TENANT, name: 'Só nome', description: null });
  });

  it('células sem motivo descem como `null` — motivo é opcional AQUI, obrigatório no país', async () => {
    const { app, d } = build();

    await request(app).put(`/api/admin/permission-groups/${ID}/permissions`).send({ cellKeys: ['worker:read'] }).expect(200);

    expect(d.setPermissions).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
  });

  it('feature sem `config` desce como `null`', async () => {
    const { app, d } = build();

    await request(app).put('/api/admin/country-features/AR/screen:x').send({ enabled: true, reason: 'x' }).expect(200);

    expect(d.setFeature).toHaveBeenCalledWith(expect.objectContaining({ config: null }));
  });
});

describe('cada rota chega no use case certo, com o payload certo', () => {
  it('POST /permission-groups', async () => {
    const { app, d } = build();
    await request(app).post('/api/admin/permission-groups').send({ name: 'Recrutamento AR', description: 'x' }).expect(200);
    expect(d.create).toHaveBeenCalledWith({ tenantId: TENANT, name: 'Recrutamento AR', description: 'x' });
  });

  it('PATCH /permission-groups/:id', async () => {
    const { app, d } = build();
    await request(app).patch(`/api/admin/permission-groups/${ID}`).send({ name: 'Novo' }).expect(200);
    expect(d.update).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID, name: 'Novo' });
  });

  it('DELETE /permission-groups/:id ARQUIVA — a trilha sobrevive ao grupo', async () => {
    const { app, d } = build();
    const res = await request(app).delete(`/api/admin/permission-groups/${ID}`).expect(200);
    expect(d.archive).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID });
    expect(res.body).toEqual({ affectedMembers: 0 });
  });

  it('PUT /:id/permissions substitui o conjunto inteiro', async () => {
    const { app, d } = build();
    await request(app).put(`/api/admin/permission-groups/${ID}/permissions`)
      .send({ cellKeys: ['worker:read', 'funnel:read'], reason: 'onboarding' }).expect(200);
    expect(d.setPermissions).toHaveBeenCalledWith({
      tenantId: TENANT, groupId: ID, cellKeys: ['worker:read', 'funnel:read'], reason: 'onboarding',
    });
  });

  it('POST /:id/countries exige motivo e o repassa', async () => {
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/countries`).send({ country: 'BR', reason: 'expansão' }).expect(200);
    expect(d.grantCountry).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID, country: 'BR', reason: 'expansão' });
  });

  it('DELETE /:id/countries/:country', async () => {
    const { app, d } = build();
    await request(app).delete(`/api/admin/permission-groups/${ID}/countries/AR`).expect(200);
    expect(d.revokeCountry).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID, country: 'AR' });
  });

  it('POST /:id/members', async () => {
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/members`).send({ userId: 'uid-1' }).expect(200);
    expect(d.addMember).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID, userId: 'uid-1' });
  });

  it('DELETE /:id/members — userId no CORPO, não no path (C6)', async () => {
    const { app, d } = build();
    await request(app).delete(`/api/admin/permission-groups/${ID}/members`).send({ userId: 'uid-1' }).expect(200);
    expect(d.removeMember).toHaveBeenCalledWith({ tenantId: TENANT, groupId: ID, userId: 'uid-1' });
  });

  it('PUT /country-features/:country/:featureKey', async () => {
    const { app, d } = build();
    await request(app).put('/api/admin/country-features/BR/screen:talentum')
      .send({ enabled: false, config: null, reason: 'piloto' }).expect(200);
    expect(d.setFeature).toHaveBeenCalledWith({
      country: 'BR', featureKey: 'screen:talentum', enabled: false, config: null, reason: 'piloto',
    });
  });

  it('use case que devolve `undefined` vira `{success:true}` — não corpo vazio', async () => {
    // `update` e `setFeature` resolvem `void`: sem o `??`, o cliente receberia
    // corpo vazio com 200 e não teria como distinguir de resposta truncada.
    const { app } = build({ update: jest.fn().mockResolvedValue(undefined) });

    const res = await request(app).patch(`/api/admin/permission-groups/${ID}`).send({ name: 'X' }).expect(200);

    expect(res.body).toEqual({ success: true });
  });
});

describe('zod na borda — recusa ANTES de qualquer ida ao banco', () => {
  it('grupo sem nome é 400', async () => {
    const { app, d } = build();
    await request(app).post('/api/admin/permission-groups').send({ description: 'só isso' }).expect(400);
    expect(d.create).not.toHaveBeenCalled();
  });

  it('🔴 PATCH vazio é 400 — "salvei nada" e "salvei" não podem ser a mesma resposta', async () => {
    const { app, d } = build();
    const res = await request(app).patch(`/api/admin/permission-groups/${ID}`).send({}).expect(400);
    expect(res.body).toEqual({ success: false, error: 'Invalid group payload' });
    expect(d.update).not.toHaveBeenCalled();
  });

  it('id malformado é 400 em todas as rotas com `:id`', async () => {
    const { app, d } = build();
    await request(app).patch('/api/admin/permission-groups/nao-uuid').send({ name: 'X' }).expect(400);
    await request(app).delete('/api/admin/permission-groups/nao-uuid').expect(400);
    await request(app).put('/api/admin/permission-groups/nao-uuid/permissions').send({ cellKeys: [] }).expect(400);
    await request(app).post('/api/admin/permission-groups/nao-uuid/countries').send({ country: 'AR', reason: 'x' }).expect(400);
    await request(app).delete('/api/admin/permission-groups/nao-uuid/countries/AR').expect(400);
    await request(app).post('/api/admin/permission-groups/nao-uuid/members').send({ userId: 'u' }).expect(400);
    await request(app).delete('/api/admin/permission-groups/nao-uuid/members').send({ userId: 'u' }).expect(400);
    expect(Object.values(d).every((m) => m.mock.calls.length === 0)).toBe(true);
  });

  it('país fora do catálogo é 400 — na concessão, na revogação e na feature', async () => {
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/countries`).send({ country: 'XX', reason: 'x' }).expect(400);
    await request(app).delete(`/api/admin/permission-groups/${ID}/countries/XX`).expect(400);
    await request(app).put('/api/admin/country-features/XX/screen:x').send({ enabled: true, reason: 'x' }).expect(400);
    expect(d.grantCountry).not.toHaveBeenCalled();
    expect(d.revokeCountry).not.toHaveBeenCalled();
    expect(d.setFeature).not.toHaveBeenCalled();
  });

  it('🔒 concessão de país SEM motivo PASSA — e chega ao use case como null', async () => {
    // era 400 até 05/09. Mudou por decisão do Gabriel: motivo por país não é
    // uma justificativa que exista, e campo obrigatório sem conteúdo real vira
    // "ok"/"." — o oposto de trilha. Quem guarda o ato é granted_by/created_at.
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/countries`).send({ country: 'BR' }).expect(200);
    expect(d.grantCountry).toHaveBeenCalledWith(expect.objectContaining({ country: 'BR', reason: null }));
  });

  it('🔴 país inválido continua 400 — o que amplia alcance segue validado', async () => {
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/countries`).send({ country: 'US' }).expect(400);
    expect(d.grantCountry).not.toHaveBeenCalled();
  });

  it('feature sem motivo, ou com `enabled` não-booleano, é 400', async () => {
    const { app, d } = build();
    await request(app).put('/api/admin/country-features/AR/screen:x').send({ enabled: true }).expect(400);
    await request(app).put('/api/admin/country-features/AR/screen:x').send({ enabled: 'sim', reason: 'x' }).expect(400);
    expect(d.setFeature).not.toHaveBeenCalled();
  });

  it('membro sem userId é 400', async () => {
    const { app, d } = build();
    await request(app).post(`/api/admin/permission-groups/${ID}/members`).send({}).expect(400);
    expect(d.addMember).not.toHaveBeenCalled();
  });

  it('remoção de membro sem userId no CORPO é 400 — mesmo schema do POST', async () => {
    const { app, d } = build();
    await request(app).delete(`/api/admin/permission-groups/${ID}/members`).send({}).expect(400);
    expect(d.removeMember).not.toHaveBeenCalled();
  });

  it('`cellKeys` que não é lista é 400', async () => {
    const { app, d } = build();
    await request(app).put(`/api/admin/permission-groups/${ID}/permissions`).send({ cellKeys: 'worker:read' }).expect(400);
    expect(d.setPermissions).not.toHaveBeenCalled();
  });

  it('lista de células VAZIA é aceita — tirar tudo de um grupo é operação legítima', async () => {
    // E o anti-lockout do banco é quem recusa se isso deixar zero gestores.
    const { app, d } = build();
    await request(app).put(`/api/admin/permission-groups/${ID}/permissions`).send({ cellKeys: [] }).expect(200);
    expect(d.setPermissions).toHaveBeenCalledWith(expect.objectContaining({ cellKeys: [] }));
  });
});

describe('erro de domínio → HTTP: é o contrato que a tela lê', () => {
  const mapa: Array<[string, number]> = [
    ['forbidden', 403], ['not_found', 404], ['duplicate_name', 409], ['system_group', 409],
    ['last_manager', 409], ['invalid_cell', 400], ['reason_required', 400],
    ['invalid_feature_key', 400], ['invalid_feature_config', 400], ['invalid_country', 400],
    ['invalid_input', 400],
  ];

  it.each(mapa)('`%s` vira %i, com o código no corpo e a frase da CASA', async (code, status) => {
    // ⚠️ A mensagem original NÃO vai no corpo. Medido pelo gate: no 23505 o
    // `perm.message` é `duplicate key value violates unique constraint
    // "permission_groups_tenant_id_name_key"` — nome de tabela e de constraint
    // para o cliente. O `code` é o que a tela consome; a frase é nossa.
    const original = `CRU DO POSTGRES: ${code} em permission_groups_tenant_id_name_key`;
    const { app } = build({ create: jest.fn().mockRejectedValue(new PermissionError(code as never, original)) });

    const res = await request(app).post('/api/admin/permission-groups').send({ name: 'G' }).expect(status);

    expect(res.body.code).toBe(code);
    expect(res.body.error).not.toContain('permission_groups_tenant_id_name_key');
    expect(res.body.error).not.toContain('CRU DO POSTGRES');
    expect(typeof res.body.error).toBe('string');
    expect((res.body.error as string).length).toBeGreaterThan(0);
  });

  it('🔴 `last_manager` é 409, NÃO 403 — quem pediu tinha permissão', async () => {
    // 403 mandaria a pessoa procurar a permissão que falta, que não é o
    // problema: o que o sistema recusa é o ESTADO resultante.
    const { app } = build({ removeMember: jest.fn().mockRejectedValue(new PermissionError('last_manager', 'deixaria zero gestores')) });

    const res = await request(app).delete(`/api/admin/permission-groups/${ID}/members`).send({ userId: 'uid-1' }).expect(409);

    expect(res.body.code).toBe('last_manager');
    expect(res.body.error).toBe('A operação deixaria a empresa sem nenhum gestor de acessos.');
  });

  it('🔴 erro do DRIVER é traduzido — a borda não conhece SQLSTATE', async () => {
    const pg = Object.assign(new Error('[iam] ator sem permission_management:write'), { code: '42501' });
    const { app } = build({ create: jest.fn().mockRejectedValue(pg) });

    const res = await request(app).post('/api/admin/permission-groups').send({ name: 'G' }).expect(403);

    expect(res.body.code).toBe('forbidden');
  });

  it('anti-lockout do banco (23514 + "anti-lockout") vira 409 `last_manager`', async () => {
    const pg = Object.assign(new Error('[iam] operação rejeitada: ... (anti-lockout)'), { code: '23514' });
    const { app } = build({ archive: jest.fn().mockRejectedValue(pg) });

    const res = await request(app).delete(`/api/admin/permission-groups/${ID}`).expect(409);

    expect(res.body.code).toBe('last_manager');
  });

  it('🔴 erro que NÃO é de permissão continua 500 — o 4xx não vira guarda-chuva', async () => {
    const { app } = build({ create: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });

    const res = await request(app).post('/api/admin/permission-groups').send({ name: 'G' }).expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to create group' });
    expect(res.body.code).toBeUndefined();
  });
});
