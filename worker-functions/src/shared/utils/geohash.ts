/**
 * geohash5 — geocódigo base32 de precisão FIXA em 5, do centro de uma busca de
 * mapa. Existe por uma condição do lex (30/08, C5): a trilha de leitura em
 * massa (OP-11) precisa deixar RECONSTRUIR o escopo de uma varredura, e sem
 * nenhuma referência de lugar a trilha não responde "onde ele olhou?".
 *
 * Por que geohash e não lat/lng: a coordenada crua do centro é a casa de
 * alguém (o picker "Centrar en paciente" da tela põe o centro na coordenada
 * EXATA do domicílio de um paciente), e o log do Cloud Run vive 30 dias. O
 * geohash de 5 caracteres é uma célula de ~4,9 km × ~4,9 km no equador — em
 * Buenos Aires, ~4,9 km × ~4,0 km. Isso é grosso o bastante para dizer "olhou
 * a zona sul" e fino o bastante para auditar; não é endereço.
 *
 * ⚠️ PRECISÃO FIXA, SEM PARÂMETRO — de propósito. Precisão é decisão de
 * privacidade, não configuração: um `precision` opcional acaba chamado com 8
 * por alguém que quis "um pouco mais de detalhe", e 8 é o quarteirão. Quem
 * precisar mudar edita esta função e quebra `geohash.test.ts`, que trava o
 * comprimento em 5 — o vermelho é o pedido de explicação.
 *
 * PURA e LOCAL: nenhuma rede, nenhuma dependência nova, nada de estado. É o
 * algoritmo base32 padrão (Niemeyer), com o alfabeto canônico — os vetores do
 * teste conferem contra o exemplo publicado (42,6 / -5,6 → `ezs42`).
 */

/** Alfabeto base32 do geohash: sem 'a', 'i', 'l' e 'o' (confusão visual). */
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Geohash de precisão 5 de um ponto. Bissecção alternada: bit par refina a
 * longitude ([-180, 180]), bit ímpar refina a latitude ([-90, 90]); a cada 5
 * bits sai um caractere. Sempre devolve EXATAMENTE 5 caracteres.
 */
export function geohash5(lat: number, lng: number): string {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let isLng = true;
  let bitsInChunk = 0;
  let chunk = 0;
  let hash = '';

  // O `5` do laço é o teto de precisão — é ele que o teste trava.
  while (hash.length < 5) {
    if (isLng) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) { chunk = chunk * 2 + 1; lngLo = mid; } else { chunk *= 2; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { chunk = chunk * 2 + 1; latLo = mid; } else { chunk *= 2; latHi = mid; }
    }
    isLng = !isLng;
    bitsInChunk++;
    if (bitsInChunk === 5) {
      hash += GEOHASH_BASE32[chunk];
      bitsInChunk = 0;
      chunk = 0;
    }
  }

  return hash;
}
