/**
 * geohash.test.ts — a trava da condição C5 do lex (30/08).
 *
 * Duas coisas são provadas aqui, e a segunda é a que importa para privacidade:
 *   1. o algoritmo é o base32 padrão — conferido contra o vetor PUBLICADO
 *      (42,6 / -5,6 → `ezs42`, o exemplo canônico do formato) e contra dois
 *      pontos reais da operação (Obelisco e Av. Paulista);
 *   2. a saída tem EXATAMENTE 5 caracteres. Quem aumentar a precisão dentro da
 *      função para "detalhar um pouco mais" fica vermelho aqui — precisão é
 *      decisão de privacidade, não configuração.
 */
import { geohash5 } from '../geohash';

describe('geohash5 — vetores conhecidos', () => {
  it('o vetor canônico publicado do formato: (42,6 / -5,6) → ezs42', () => {
    // Se este falhar, o algoritmo não é geohash — é outra coisa com 5 letras.
    expect(geohash5(42.6, -5.6)).toBe('ezs42');
  });

  it('Obelisco de Buenos Aires (-34,6037 / -58,3816) → 69y7p', () => {
    expect(geohash5(-34.6037, -58.3816)).toBe('69y7p');
  });

  it('Av. Paulista, São Paulo (-23,5614 / -46,6559) → 6gycf', () => {
    expect(geohash5(-23.5614, -46.6559)).toBe('6gycf');
  });

  it('extremos do domínio: (0,0) → s0000, (90,180) → zzzzz, (-90,-180) → 00000', () => {
    // Cobrem os dois lados de cada bissecção (todo bit 1 e todo bit 0).
    expect(geohash5(0, 0)).toBe('s0000');
    expect(geohash5(90, 180)).toBe('zzzzz');
    expect(geohash5(-90, -180)).toBe('00000');
  });
});

describe('geohash5 — precisão travada em 5', () => {
  it('SEMPRE exatamente 5 caracteres, em qualquer ponto', () => {
    const pontos: Array<[number, number]> = [
      [42.6, -5.6], [-34.6037, -58.3816], [-23.5614, -46.6559],
      [0, 0], [90, 180], [-90, -180], [-34.9215, -57.9545], [51.5074, -0.1278],
    ];
    for (const [lat, lng] of pontos) {
      expect(geohash5(lat, lng)).toHaveLength(5);
    }
  });

  it('só usa o alfabeto base32 do geohash (sem a, i, l, o)', () => {
    expect(geohash5(-34.6037, -58.3816)).toMatch(/^[0123456789bcdefghjkmnpqrstuvwxyz]{5}$/);
  });

  it('é uma CÉLULA, não um endereço: pontos a ~1 km caem no mesmo código', () => {
    // Obelisco e um ponto ~1 km ao norte: a trilha diz a zona, nunca a casa.
    expect(geohash5(-34.6037, -58.3816)).toBe(geohash5(-34.5950, -58.3816));
  });

  it('é determinística e pura: mesma entrada, mesma saída, sem estado entre chamadas', () => {
    expect(geohash5(-34.6037, -58.3816)).toBe('69y7p');
    expect(geohash5(42.6, -5.6)).toBe('ezs42');
    expect(geohash5(-34.6037, -58.3816)).toBe('69y7p');
  });
});
