/**
 * spec 016 F4, Parte 2 (backfill) — casamento em memória entre o texto livre de
 * `patients.diagnosis` e um candidato do catálogo CID-11. Puro: sem `pg`, sem HTTP.
 *
 * "Alta confiança" (D260: "não inventa") = exatamente UM candidato cujo título, normalizado
 * (trim + minúsculas + sem acento), é IGUAL ao texto normalizado. Zero candidatos, ou mais de
 * um empatando, NÃO é alta confiança — o valor fica como está (nenhuma inferência por
 * similaridade aproximada: `word_similarity` já é o que a BUSCA usa para tolerar erro de
 * digitação; aqui o padrão é mais estrito de propósito, porque o resultado é ESCRITA).
 *
 * ⚠️ Nenhum destes testes usa texto CLÍNICO real — os literais abaixo são sintéticos, criados
 * para este teste (nunca colados do banco).
 */
import { matchByExactTitle } from '../backfill-diagnosis-catalog/matching';

describe('matchByExactTitle', () => {
  it('UM candidato com título idêntico (case/acento-insensível) → casamento de alta confiança', () => {
    const result = matchByExactTitle('trastorno del espectro autista', [
      { uri: 'uri-1', title: 'Trastorno del Espectro Autista' },
    ]);
    expect(result).toEqual({ matched: true, uri: 'uri-1' });
  });

  it('acentuação e espaços nas pontas não impedem o casamento', () => {
    const result = matchByExactTitle('  PARALISIS CEREBRAL  ', [
      { uri: 'uri-2', title: 'Parálisis Cerebral' },
    ]);
    expect(result).toEqual({ matched: true, uri: 'uri-2' });
  });

  it('ZERO candidatos → sem casamento (nunca inventa)', () => {
    const result = matchByExactTitle('sindrome inexistente', []);
    expect(result).toEqual({ matched: false });
  });

  it('MAIS DE UM candidato empatando no título normalizado → ambíguo, sem casamento', () => {
    const result = matchByExactTitle('esquizofrenia', [
      { uri: 'uri-a', title: 'Esquizofrenia' },
      { uri: 'uri-b', title: 'esquizofrenia' },
    ]);
    expect(result).toEqual({ matched: false });
  });

  it('candidato PARECIDO mas não idêntico → sem casamento (padrão é EXATO, não fuzzy)', () => {
    const result = matchByExactTitle('esquizofrenia primer episodio', [
      { uri: 'uri-c', title: 'Esquizofrenia' },
    ]);
    expect(result).toEqual({ matched: false });
  });

  it('texto vazio/em branco → sem casamento, sem lançar', () => {
    expect(matchByExactTitle('', [{ uri: 'x', title: 'Y' }])).toEqual({ matched: false });
    expect(matchByExactTitle('   ', [{ uri: 'x', title: 'Y' }])).toEqual({ matched: false });
  });
});
