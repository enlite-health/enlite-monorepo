import { SUMMARY_REQUIRED_FIELDS, SUMMARY_TOP_KEYS, validateSummaryShape } from '../admissionSummaryShape';
import { validSummaryJson } from '../../infrastructure/doubles/admissionSummaryFixtures';
import { assertSummaryShape } from '../../application/admissionSummaryGate';
import { AdmissionSummaryError } from '../../application/ports/AdmissionImportPorts';

describe('validateSummaryShape (spec 050 F6)', () => {
  it('fixture válida passa (controle positivo)', () => {
    expect(validateSummaryShape({ structured: validSummaryJson(), jsonInvalid: false })).toEqual({ ok: true });
  });
  it('JSON inválido ou ausente -> json_invalid', () => {
    expect(validateSummaryShape({ structured: null, jsonInvalid: true })).toMatchObject({ ok: false, reason: 'json_invalid' });
    expect(validateSummaryShape({})).toMatchObject({ ok: false, reason: 'json_invalid' });
  });
  it.each(SUMMARY_TOP_KEYS)('sem a chave de topo %s -> schema_invalid com o nome', (k) => {
    const j = validSummaryJson();
    delete j[k];
    expect(validateSummaryShape({ structured: j })).toMatchObject({ ok: false, reason: 'schema_invalid', fields: expect.arrayContaining([k]) });
  });
  it('raiz que não é objeto (lista, número) -> schema_invalid', () => {
    expect(validateSummaryShape({ structured: [] })).toMatchObject({ reason: 'schema_invalid' });
    expect(validateSummaryShape({ structured: 3 })).toMatchObject({ reason: 'schema_invalid' });
  });
  it('as duas listas têm de ser listas', () => {
    for (const k of ['campos_faltantes', 'preguntas_sugeridas']) {
      const j = validSummaryJson();
      j[k] = {};
      expect(validateSummaryShape({ structured: j })).toMatchObject({ reason: 'schema_invalid', fields: [k] });
    }
  });
  it('estado diferente reprova', () => {
    const j = validSummaryJson();
    j.estado = 'FINAL';
    expect(validateSummaryShape({ structured: j })).toMatchObject({ reason: 'schema_invalid', fields: ['estado'] });
  });
  it.each(SUMMARY_REQUIRED_FIELDS)('obrigatório %s null fora dos faltantes reprova; dentro passa', (k) => {
    const j = validSummaryJson();
    j.datos_administrativos[k] = { valor: null };
    expect(validateSummaryShape({ structured: j })).toMatchObject({ reason: 'schema_invalid', fields: [k] });
    j.campos_faltantes = [k];
    expect(validateSummaryShape({ structured: j })).toEqual({ ok: true });
  });
  it('campo NÃO obrigatório null fora dos faltantes não reprova', () => {
    const j = validSummaryJson();
    j.datos_administrativos.pac_telefono = { valor: null };
    expect(validateSummaryShape({ structured: j })).toEqual({ ok: true });
  });
});

describe('cruzamento tolerante com `campos_faltantes`', () => {
  const k = 'resp_whatsapp';
  const com = (item: unknown) => {
    const j = validSummaryJson();
    j.datos_administrativos[k] = { valor: null };
    j.campos_faltantes = [item];
    return validateSummaryShape({ structured: j });
  };
  it.each([
    ['string igual', 'resp_whatsapp'],
    ['string com espaços e caixa diferente', '  Resp_WhatsApp '],
    ['caminho com ponto (último segmento)', 'datos_administrativos.resp_whatsapp'],
    ['caminho com ponto e caixa/espaço', ' Datos_Administrativos.RESP_WHATSAPP '],
    ['objeto com valor string igual', { campo: 'resp_whatsapp' }],
    ['objeto com valor-caminho', { campo: 'datos_administrativos.resp_whatsapp', motivo: 'no se mencionó' }],
  ])('cobre: %s', (_n, item) => {
    expect(com(item)).toEqual({ ok: true });
  });
  it.each([
    ['rótulo humano', 'WhatsApp del responsable'],
    ['objeto só com rótulo humano', { campo: 'WhatsApp del responsable' }],
    ['outra chave', 'resp_email'],
    ['número', 42],
    ['caminho que termina em outra chave', 'resp_whatsapp.otro'],
  ])('NÃO cobre: %s', (_n, item) => {
    expect(com(item)).toMatchObject({ ok: false, reason: 'schema_invalid', fields: [k] });
  });
});

describe('assertSummaryShape', () => {
  it('lança AdmissionSummaryError com o motivo e só o nome do campo', () => {
    const j = validSummaryJson();
    j.estado = 'X';
    try {
      assertSummaryShape({ summary: 's', promptVersion: 'v', structured: j });
      throw new Error('não lançou');
    } catch (e) {
      expect(e).toBeInstanceOf(AdmissionSummaryError);
      expect(e).toMatchObject({ reason: 'schema_invalid', placeholders: ['estado'] });
    }
  });
  it('devolve o próprio resultado quando válido', () => {
    const r = { summary: 's', promptVersion: 'v', structured: validSummaryJson() };
    expect(assertSummaryShape(r)).toBe(r);
  });
});
