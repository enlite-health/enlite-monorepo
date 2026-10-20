/**
 * AdminInsuranceProviderContactsController + InsuranceProviderContactRepository (cartão Empregados; spec 058 §3.2).
 * Cifra como `PatientResponsibleRepository`; DECIFRA só com `insurance_provider_contacts:read`; refine do par tipo+número do documento
 * (`DOCUMENT_PAIR_INCOMPLETE`) antes do banco; nenhum valor pessoal em log nem em resposta de erro.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: () => ({ principal: { id: 'uid-admin' } }) } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminInsuranceProviderContactsController, CONTACTS_READ_CELL } from '../controllers/AdminInsuranceProviderContactsController';
import { InsuranceProviderContactRepository } from '../../infrastructure/InsuranceProviderContactRepository';
import { createInsuranceContactSchema } from '../validators/insuranceContactSchemas';

const CONTACT_ID = '66666666-6666-4666-8666-666666666666';
const SECRET_PHONE = '+54 11 5555-0000';
const SECRET_EMAIL = 'maria.secreta@osde.example';
const SECRET_DOC = '30123456';

const enc = (v: string | null | undefined): string | null => (v ? `enc(${v})` : null);
const dec = (c: string | null | undefined): string => (c ? c.replace(/^enc\(/, '').replace(/\)$/, '') : '');

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    full_name: 'Maria Gomez',
    role_title: 'Auditora',
    phone_encrypted: enc(SECRET_PHONE),
    email_encrypted: enc(SECRET_EMAIL),
    document_type: 'DNI',
    document_number_encrypted: enc(SECRET_DOC),
    retired_at: null,
    ...over,
  };
}

function build(poolQuery: jest.Mock) {
  const decrypt = jest.fn(async (c: string | null | undefined) => dec(c));
  const encrypt = jest.fn(async (v: string | null | undefined) => enc(v));
  const repo = new InsuranceProviderContactRepository({ encrypt, decrypt }, () => ({ query: poolQuery }) as never);
  return { ctrl: new AdminInsuranceProviderContactsController(repo), decrypt, encrypt };
}

function reqRes(over: { body?: unknown; params?: Record<string, string>; cells?: string[] | null; roles?: string[] } = {}): [Request, Response, jest.Mock] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = {
    body: over.body ?? {},
    params: over.params ?? { code: 'OSDE', contactId: CONTACT_ID },
    query: {},
    permissionCells: over.cells === undefined ? [CONTACTS_READ_CELL] : over.cells,
    user: { roles: over.roles ?? ['admin'] },
  } as unknown as Request;
  return [req, { json, status } as unknown as Response, json];
}

describe('AdminInsuranceProviderContactsController', () => {
  let poolQuery: jest.Mock;
  beforeEach(() => {
    jest.clearAllMocks();
    poolQuery = jest.fn();
  });

  it('list: com a célula de leitura DECIFRA telefone, e-mail e número do documento', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const { ctrl, decrypt } = build(poolQuery);
    const [req, res, json] = reqRes({ params: { code: 'OSDE' } });
    await ctrl.list(req, res);
    expect(decrypt).toHaveBeenCalled();
    expect(json.mock.calls[0][0].data.items[0]).toEqual({
      id: CONTACT_ID, fullName: 'Maria Gomez', roleTitle: 'Auditora', phone: SECRET_PHONE, email: SECRET_EMAIL,
      document: { type: 'DNI', number: SECRET_DOC }, retired: false, redacted: false,
    });
  });

  it('sem leitura não decifra: sem a célula o KMS nem é chamado e telefone/e-mail/número vêm null (list, create e patch)', async () => {
    const { ctrl, decrypt } = build(poolQuery);
    poolQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, cells: [] });
    await ctrl.list(req, res);
    expect(decrypt).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].data.items[0]).toMatchObject({ phone: null, email: null, document: { type: 'DNI', number: null }, redacted: true });
    for (const secret of [SECRET_PHONE, SECRET_EMAIL, SECRET_DOC]) expect(JSON.stringify(json.mock.calls[0][0])).not.toContain(secret);

    poolQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const [req2, res2, json2] = reqRes({ params: { code: 'OSDE' }, cells: ['insurance_provider_contacts:create'], body: { fullName: 'Maria Gomez', roleTitle: 'Auditora', phone: SECRET_PHONE } });
    await ctrl.create(req2, res2);
    expect(decrypt).not.toHaveBeenCalled();
    expect(json2.mock.calls[0][0].data).toMatchObject({ phone: null, redacted: true });

    poolQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const [req3, res3] = reqRes({ cells: ['insurance_provider_contacts:update'], body: { roleTitle: 'Chefa' } });
    await ctrl.patch(req3, res3);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('família ainda não enforçada (células null): só o papel admin lê; o resto vê redigido', async () => {
    const { ctrl, decrypt } = build(poolQuery);
    poolQuery.mockResolvedValue({ rows: [dbRow()] });
    const [reqA, resA] = reqRes({ params: { code: 'OSDE' }, cells: null, roles: ['admin'] });
    await ctrl.list(reqA, resA);
    expect(decrypt).toHaveBeenCalled();
    decrypt.mockClear();
    const [reqR, resR] = reqRes({ params: { code: 'OSDE' }, cells: null, roles: ['recruiter'] });
    await ctrl.list(reqR, resR);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('create: cifra telefone, e-mail e número ANTES de gravar; o documentType segue em claro; autoria = uid do ator', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const { ctrl, encrypt } = build(poolQuery);
    const [req, res] = reqRes({ params: { code: 'OSDE' }, body: { fullName: ' Maria Gomez ', roleTitle: 'Auditora', phone: SECRET_PHONE, email: ` ${SECRET_EMAIL} `, documentType: 'DNI', documentNumber: SECRET_DOC } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(encrypt).toHaveBeenCalledWith(SECRET_PHONE);
    expect(encrypt).toHaveBeenCalledWith(SECRET_EMAIL); // trim antes da cifra
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO insurance_provider_contacts/);
    expect(params).toEqual(['OSDE', 'Maria Gomez', 'Auditora', enc(SECRET_PHONE), enc(SECRET_EMAIL), 'DNI', enc(SECRET_DOC), 'uid-admin']);
    expect(JSON.stringify(params.slice(0, 3))).not.toContain(SECRET_PHONE);
  });

  it('DOCUMENT_PAIR_INCOMPLETE: tipo sem número (ou número sem tipo) → 422 antes do banco; os dois valores ou os dois null passam', async () => {
    const { ctrl } = build(poolQuery);
    const base = { fullName: 'Maria Gomez', roleTitle: 'Auditora', phone: SECRET_PHONE };
    for (const extra of [{ documentType: 'DNI' }, { documentNumber: SECRET_DOC }, { documentType: 'DNI', documentNumber: null }, { documentType: null, documentNumber: SECRET_DOC }]) {
      const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { ...base, ...extra } });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(json.mock.calls[0][0].code).toBe('DOCUMENT_PAIR_INCOMPLETE');
    }
    for (const extra of [{}, { documentType: null, documentNumber: null }, { documentType: 'PASSPORT', documentNumber: 'X123' }]) {
      expect(createInsuranceContactSchema.safeParse({ ...base, ...extra }).success).toBe(true);
    }
    // PATCH: o par vale igual
    const [rp, sp, jp] = reqRes({ body: { documentNumber: SECRET_DOC } });
    await ctrl.patch(rp, sp);
    expect(sp.status).toHaveBeenCalledWith(422);
    expect(jp.mock.calls[0][0].code).toBe('DOCUMENT_PAIR_INCOMPLETE');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('validação: tipo de documento fora do vocabulário, e-mail inválido, nome em branco → 400 no POST; "" e null em campo NOT NULL → 422 no PATCH', async () => {
    const { ctrl } = build(poolQuery);
    const base = { fullName: 'Maria', roleTitle: 'Auditora', phone: '123' };
    for (const extra of [{ documentType: 'RG', documentNumber: '1' }, { email: 'sem-arroba' }, { fullName: '   ' }]) {
      const [req, res] = reqRes({ params: { code: 'OSDE' }, body: { ...base, ...extra } });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    for (const body of [{ fullName: '' }, { phone: null }, { roleTitle: null }, { email: '' }]) {
      const [req, res, json] = reqRes({ body });
      await ctrl.patch(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(json.mock.calls[0][0].code).toBe('VALIDATION_FAILED');
    }
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('patch: ausente não toca; null limpa o e-mail e o PAR do documento; só as chaves presentes viram SET', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [dbRow({ email_encrypted: null, document_type: null, document_number_encrypted: null })] });
    const { ctrl } = build(poolQuery);
    const [req, res] = reqRes({ body: { email: null, documentType: null, documentNumber: null } });
    await ctrl.patch(req, res);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(sql).toMatch(/SET email_encrypted = \$4, document_type = \$5, document_number_encrypted = \$6, updated_by = \$3/);
    expect(sql.split('RETURNING')[0]).not.toMatch(/full_name|role_title|phone_encrypted/);
    expect(params.slice(3)).toEqual([null, null, null]);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('patch/retire: contato de outra obra social ou inexistente → 404; já aposentado → 409', async () => {
    const { ctrl } = build(poolQuery);
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const [req, res] = reqRes({ body: { roleTitle: 'X' } });
    await ctrl.patch(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ retired_at: new Date() }] });
    const [req2, res2, json2] = reqRes();
    await ctrl.retire(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(json2.mock.calls[0][0].code).toBe('CONTACT_RETIRED');
  });

  it('retire: nunca DELETE — o UPDATE manda "infinity" e a trigger carimba o now() do banco', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [dbRow({ retired_at: new Date() })] });
    const { ctrl } = build(poolQuery);
    const [req, res, json] = reqRes();
    await ctrl.retire(req, res);
    expect(poolQuery.mock.calls[0][0]).toMatch(/SET retired_at = 'infinity'/);
    expect(poolQuery.mock.calls.every(([s]) => !/DELETE/i.test(s as string))).toBe(true);
    expect(json.mock.calls[0][0].data.retired).toBe(true);
  });

  it('log sem PII: o erro do banco (que pode ecoar a linha) NÃO vai a reportError nem à resposta; só ids e nome da operação', async () => {
    poolQuery.mockRejectedValueOnce(new Error(`duplicate key ... Key (phone_encrypted)=(${enc(SECRET_PHONE)}) / ${SECRET_EMAIL} / ${SECRET_DOC}`));
    const { ctrl } = build(poolQuery);
    const [req, res, json] = reqRes({ params: { code: 'OSDE' }, body: { fullName: 'Maria Gomez', roleTitle: 'Auditora', phone: SECRET_PHONE, email: SECRET_EMAIL, documentType: 'DNI', documentNumber: SECRET_DOC } });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((reportError as jest.Mock).mock.calls.map(([e, ctx]) => [String((e as Error).message), (e as Error).name, ctx]));
    const respondido = JSON.stringify(json.mock.calls);
    for (const secret of [SECRET_PHONE, SECRET_EMAIL, SECRET_DOC, 'Maria Gomez']) {
      expect(logged).not.toContain(secret);
      expect(respondido).not.toContain(secret);
    }
    expect((reportError as jest.Mock).mock.calls[0][1]).toEqual({ source: 'AdminInsuranceProviderContactsController:create', providerCode: 'OSDE' });
  });

  it('construtor sem repositório injetado constrói o real (pool e KMS preguiçosos)', () => {
    expect(new AdminInsuranceProviderContactsController()).toBeInstanceOf(AdminInsuranceProviderContactsController);
  });
});
