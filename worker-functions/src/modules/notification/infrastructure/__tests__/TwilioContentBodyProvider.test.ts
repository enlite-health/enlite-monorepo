const mockReportError = jest.fn();
const mockWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
  logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), child: jest.fn() },
}));

import { Pool } from 'pg';
import { TwilioContentBodyProvider, bodyOfContentPayload, MAX_LAZY_FETCH, FETCH_TIMEOUT_MS } from '../TwilioContentBodyProvider';

const okRes = (types: unknown) => ({ ok: true, status: 200, json: async () => ({ types }) });
const makeDb = (query = jest.fn().mockResolvedValue({ rows: [] })) => ({ query } as unknown as Pool & { query: jest.Mock });

describe('bodyOfContentPayload — a MESMA regra do sync (importada, não copiada)', () => {
  it('devolve o texto aprovado; Content sem texto → null, NUNCA sentinela', () => {
    expect(bodyOfContentPayload({ types: { 'twilio/text': { body: 'Hola {{1}}' } } })).toBe('Hola {{1}}');
    expect(bodyOfContentPayload({ types: { 'twilio/card': { body: '  ' }, 'twilio/text': { body: 'ok' } } })).toBe('ok');
    // título de card não é a mensagem que a cuidadora recebe
    expect(bodyOfContentPayload({ types: { 'twilio/card': { title: 'x' } } })).toBeNull();
    expect(bodyOfContentPayload({})).toBeNull();
    expect(bodyOfContentPayload(null)).toBeNull();
  });

  it('respeita a ordem de preferência do sync — text ganha de card', () => {
    expect(bodyOfContentPayload({ types: { 'twilio/card': { body: 'CARD' }, 'twilio/text': { body: 'TEXT' } } })).toBe('TEXT');
  });
});

describe('TwilioContentBodyProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sem injeção, a credencial vem do ambiente (é assim que o controller o constrói)', () => {
    const before = { sid: process.env.TWILIO_ACCOUNT_SID, tok: process.env.TWILIO_AUTH_TOKEN };
    delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN;
    expect(new TwilioContentBodyProvider(makeDb()).configured).toBe(false);
    process.env.TWILIO_ACCOUNT_SID = 'ACenv'; process.env.TWILIO_AUTH_TOKEN = 'tokenv';
    expect(new TwilioContentBodyProvider(makeDb()).configured).toBe(true);
    if (before.sid === undefined) delete process.env.TWILIO_ACCOUNT_SID; else process.env.TWILIO_ACCOUNT_SID = before.sid;
    if (before.tok === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = before.tok;
  });

  it('sem credencial não chama a Twilio nem grava — devolve vazio', async () => {
    const db = makeDb();
    const fetchImpl = jest.fn();
    const p = new TwilioContentBodyProvider(db, undefined, undefined, fetchImpl);
    expect(p.configured).toBe(false);
    await expect(p.fillMissing([{ slug: 'a', content_sid: 'HX1' }])).resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    // credencial ausente não pode ser silêncio: é o motivo de a tela ficar sem texto
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'twilio_content_sem_credencial' }));
  });

  it('busca o corpo, GRAVA em body_twilio e devolve slug → corpo', async () => {
    const db = makeDb();
    const fetchImpl = jest.fn().mockResolvedValue(okRes({ 'twilio/text': { body: 'Hola {{1}}' } }));
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', fetchImpl);
    const out = await p.fillMissing([{ slug: 'ar_finalize_signup_luz', content_sid: 'HX54d6' }]);

    expect(out.get('ar_finalize_signup_luz')).toBe('Hola {{1}}');
    expect(fetchImpl).toHaveBeenCalledWith('https://content.twilio.com/v1/Content/HX54d6', {
      headers: { Authorization: `Basic ${Buffer.from('AC1:tok').toString('base64')}` },
      signal: expect.anything(),
    });
    // teto de tempo: isto roda no caminho de uma request do painel
    expect(FETCH_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    const sql = (db.query.mock.calls[0][0] as string);
    expect(sql).toContain('UPDATE message_templates SET body_twilio');
    expect(sql).toContain('IS DISTINCT FROM');   // idempotente: N staff abrindo a tela não escrevem N vezes
    expect(sql).not.toContain('updated_at');     // caminho de LEITURA não carimba updated_at
    expect(db.query.mock.calls[0][1]).toEqual(['ar_finalize_signup_luz', 'Hola {{1}}']);
  });

  it('sem content_sid pula; HTTP não-ok e exceção viram reportError sem derrubar o resto', async () => {
    const db = makeDb();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockRejectedValueOnce(new Error('rede'))
      .mockResolvedValueOnce(okRes({ 'twilio/text': { body: 'vale' } }));
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', fetchImpl);

    const out = await p.fillMissing([
      { slug: 'sem_sid', content_sid: null },
      { slug: 'quatro_zero_quatro', content_sid: 'HX404' },
      { slug: 'explode', content_sid: 'HXERR' },
      { slug: 'bom', content_sid: 'HXOK' },
    ]);

    expect([...out.keys()]).toEqual(['bom']);
    expect(mockReportError).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('rejeição que não é Error também é reportada (sem quebrar o laço)', async () => {
    const db = makeDb();
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', jest.fn().mockRejectedValue('caiu'));
    await expect(p.fillMissing([{ slug: 'a', content_sid: 'HX1' }])).resolves.toEqual(new Map());
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ slug: 'a' }));
  });

  it('corpo ausente no payload não grava nada', async () => {
    const db = makeDb();
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', jest.fn().mockResolvedValue(okRes({ 'twilio/card': {} })));
    await expect(p.fillMissing([{ slug: 'a', content_sid: 'HX1' }])).resolves.toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
    // 200 com forma inesperada também não pode ser silêncio
    expect(mockWarn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'twilio_content_sem_texto', slug: 'a' }));
  });

  it(`nunca passa de ${MAX_LAZY_FETCH} chamadas por request`, async () => {
    const db = makeDb();
    const fetchImpl = jest.fn().mockResolvedValue(okRes({ 'twilio/text': { body: 'x' } }));
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', fetchImpl);
    await p.fillMissing(Array.from({ length: MAX_LAZY_FETCH + 5 }, (_, i) => ({ slug: `s${i}`, content_sid: `HX${i}` })));
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LAZY_FETCH);
  });
});
