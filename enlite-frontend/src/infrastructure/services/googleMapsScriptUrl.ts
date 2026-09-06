/**
 * A ÚNICA construção da URL do script do Google Maps nesta aplicação.
 *
 * ⚠️ Por que existe um módulo só para montar uma string: o script do Maps carrega
 * **uma vez por página**, e as bibliotecas são decididas por quem chega primeiro.
 * Havia duas construções independentes desta URL (`loadGoogleMaps` e o
 * `GooglePlacesAutocomplete`), as duas com short-circuit se já houver um
 * `<script src*="maps.googleapis.com">` no DOM. Enquanto as duas dissessem a
 * mesma coisa, tudo bem; no dia em que divergissem, a biblioteca faltante sumiria
 * **de forma intermitente**, conforme a tela que o operador abriu antes.
 *
 * Isso deixou de ser hipótese em 06/09/2026: o traçado da rota depende de
 * `geometry`, e sem ela `useRouteOverlay` desiste **em silêncio** — nada quebra,
 * a linha simplesmente não aparece. O gate mediu: apagar `geometry` das duas
 * chamadas deixava **5.568 testes verdes** com a feature morta em produção.
 *
 * Com uma fonte só, a divergência deixa de ser possível — e o teste ao lado
 * trava as bibliotecas exigidas.
 */

/**
 * `places` — autocomplete de endereço no cadastro.
 * `geometry` — `encoding.decodePath`, sem o qual o traçado da rota não desenha.
 */
export const GOOGLE_MAPS_LIBRARIES = ['places', 'geometry'] as const;

/** Espanhol argentino: é o idioma do painel e o dos nomes de parada em CABA. */
const LANGUAGE = 'es';

export function googleMapsScriptUrl(apiKey: string): string {
  const libraries = GOOGLE_MAPS_LIBRARIES.join(',');
  return `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=${libraries}&language=${LANGUAGE}`;
}
