/**
 * toLocalUri — 🔴 o achado mais caro da F0 (relatorio.md §8.1): a API do CID-11 devolve URIs
 * ABSOLUTAS da OMS (`http://id.who.int/...`). Um crawler que siga a resposta como veio SAI do
 * perímetro e toma HTTP 401 da API real da OMS (aconteceu no spike). Esta função é o ÚNICO
 * lugar do ingestor que decide para onde uma requisição HTTP realmente vai — todo fetch do
 * crawler passa por ela antes de sair.
 */
import { toLocalUri, InvalidCanonicalUriError } from '../rewrite-host';

const LOCAL_BASE = 'http://localhost:8085/icd/release/11/2026-01/mms';

describe('toLocalUri', () => {
  it('reescreve o host da OMS para o host local, preservando o resto do caminho', () => {
    expect(toLocalUri('http://id.who.int/icd/release/11/2026-01/mms/1435254666', LOCAL_BASE)).toBe(
      'http://localhost:8085/icd/release/11/2026-01/mms/1435254666',
    );
  });

  it('preserva sufixos de path como /unspecified e /other (códigos residuais)', () => {
    expect(
      toLocalUri('http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified', LOCAL_BASE),
    ).toBe('http://localhost:8085/icd/release/11/2026-01/mms/437815624/unspecified');
  });

  it('é idempotente: aplicar numa URI já local devolve a mesma URI', () => {
    const already = 'http://localhost:8085/icd/release/11/2026-01/mms/123';
    expect(toLocalUri(already, LOCAL_BASE)).toBe(already);
  });

  it('funciona com qualquer host local (porta diferente, docker-compose com hostname próprio)', () => {
    expect(toLocalUri('http://id.who.int/icd/release/11/2026-01/mms/1', 'http://icd-spike-es:80/icd/release/11/2026-01/mms')).toBe(
      'http://icd-spike-es:80/icd/release/11/2026-01/mms/1',
    );
  });

  it('rejeita URI sem o marcador /icd/release/11/ esperado — nunca monta um endereço às cegas', () => {
    expect(() => toLocalUri('http://evil.example.com/nada-a-ver', LOCAL_BASE)).toThrow(InvalidCanonicalUriError);
  });

  it('rejeita quando o PRÓPRIO localBase configurado não tem o marcador — erro de configuração, não de dado', () => {
    expect(() =>
      toLocalUri('http://id.who.int/icd/release/11/2026-01/mms/1', 'http://localhost:8085/rota-errada'),
    ).toThrow(InvalidCanonicalUriError);
  });

  it('a URI resultante NUNCA aponta para id.who.int — prova de perímetro por amostragem', () => {
    const amostra = [
      'http://id.who.int/icd/release/11/2026-01/mms',
      'http://id.who.int/icd/release/11/2026-01/mms/1',
      'http://id.who.int/icd/release/11/2026-01/mms/1/unspecified',
    ];
    for (const uri of amostra) {
      expect(toLocalUri(uri, LOCAL_BASE)).not.toContain('id.who.int');
    }
  });
});
