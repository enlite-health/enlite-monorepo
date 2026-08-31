const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));

import { Pool } from 'pg';
import { TwilioContentBodyProvider, extractContentBody, MAX_LAZY_FETCH } from '../TwilioContentBodyProvider';

const okRes = (types: unknown) => ({ ok: true, status: 200, json: async () => ({ types }) });
const makeDb = (query = jest.fn().mockResolvedValue({ rows: [] })) => ({ query } as unknown as Pool & { query: jest.Mock });

describe('extractContentBody', () => {
  it('pega o primeiro type com body não vazio; sem types ou sem body → null', () => {
    expect(extractContentBody({ types: { 'twilio/text': { body: 'Hola {{1}}' } } })).toBe('Hola {{1}}');
    expect(extractContentBody({ types: { 'twilio/media': { body: '  ' }, 'twilio/text': { body: 'ok' } } })).toBe('ok');
    expect(extractContentBody({ types: { 'twilio/card': { title: 'x' } } })).toBeNull();
    expect(extractContentBody({})).toBeNull();
    expect(extractContentBody(null)).toBeNull();
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
  });

  it('busca o corpo, GRAVA em body_twilio e devolve slug → corpo', async () => {
    const db = makeDb();
    const fetchImpl = jest.fn().mockResolvedValue(okRes({ 'twilio/text': { body: 'Hola {{1}}' } }));
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', fetchImpl);
    const out = await p.fillMissing([{ slug: 'ar_finalize_signup_luz', content_sid: 'HX54d6' }]);

    expect(out.get('ar_finalize_signup_luz')).toBe('Hola {{1}}');
    expect(fetchImpl).toHaveBeenCalledWith('https://content.twilio.com/v1/Content/HX54d6', {
      headers: { Authorization: `Basic ${Buffer.from('AC1:tok').toString('base64')}` },
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE message_templates SET body_twilio'), ['ar_finalize_signup_luz', 'Hola {{1}}']);
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
  });

  it(`nunca passa de ${MAX_LAZY_FETCH} chamadas por request`, async () => {
    const db = makeDb();
    const fetchImpl = jest.fn().mockResolvedValue(okRes({ 'twilio/text': { body: 'x' } }));
    const p = new TwilioContentBodyProvider(db, 'AC1', 'tok', fetchImpl);
    await p.fillMissing(Array.from({ length: MAX_LAZY_FETCH + 5 }, (_, i) => ({ slug: `s${i}`, content_sid: `HX${i}` })));
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_LAZY_FETCH);
  });
});
