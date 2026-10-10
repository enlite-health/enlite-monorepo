import { renderStructuredLines, splitGemOutput } from '../admissionGemOutput';

describe('splitGemOutput', () => {
  it('JSON válido (com cerca) + resumo legível', () => {
    const o = splitGemOutput('```json\n{"estado":"BORRADOR_PARA_REVISION_CTM","a":{"b":"}"}}\n```\nResumen legible.');
    expect(o).toEqual({ json: { estado: 'BORRADOR_PARA_REVISION_CTM', a: { b: '}' } }, jsonInvalid: false, readable: 'Resumen legible.' });
  });
  it('JSON inválido: json null, jsonInvalid, e o legível sobra', () => {
    const o = splitGemOutput('{"a": ,}\n\nResumen legible.');
    expect(o).toMatchObject({ json: null, jsonInvalid: true, readable: 'Resumen legible.' });
  });
  it('JSON truncado sem legível: legível vazio', () => {
    expect(splitGemOutput('{"a": {"b": 1')).toMatchObject({ jsonInvalid: true, readable: '' });
  });
  it('sem JSON: tudo é legível e conta como inválido', () => {
    expect(splitGemOutput('só texto')).toMatchObject({ json: null, jsonInvalid: true, readable: 'só texto' });
  });
});

describe('renderStructuredLines', () => {
  it('chave: valor, listas com hífen, null como travessão; nada de chaves/aspas de JSON', () => {
    const lines = renderStructuredLines({ estado: 'X', dni: null, equipo: [{ nombre: 'A' }, 'B'], vacio: [] });
    expect(lines).toEqual(['estado: X', 'dni: —', 'equipo:', '  -', '    nombre: A', '  - B', 'vacio: (vacío)']);
  });
});
