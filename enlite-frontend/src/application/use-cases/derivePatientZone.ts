/**
 * derivePatientZone — porta FIELMENTE, no frontend, a regra de zona/barrio do
 * servidor (spec Localizaciones Fase 1, T1). Condição do jurídico: a mesma
 * regra tem que valer nos dois lados — o painel pré-preenche a Zona no
 * drawer de criação, e o servidor deriva a mesma coisa a partir do ClickUp.
 *
 * Fonte da verdade (SÓ LEITURA, não tocar):
 * worker-functions/src/modules/integration/infrastructure/clickup/helpers/locationHelpers.ts
 * — `extractNeighborhoodFromLocation` + `collectAddressComponentCandidates`.
 *
 * O que foi portado, e por quê o corte é seguro:
 *  - `collectAddressComponentCandidates`: percorre os componentes NA ORDEM em
 *    que vieram (o servidor documenta "Google typically orders most-specific
 *    → least-specific"), coletando o `long_name` (ou `short_name`) de todo
 *    componente cujos `types` batem com QUALQUER um de
 *    `['sublocality_level_1', 'sublocality', 'neighborhood']`. A ORDEM DO
 *    ARRAY DE ENTRADA decide, não a ordem da lista de tipos — copiado assim
 *    de propósito (não é "sublocality_level_1 sempre vence"; é "o primeiro
 *    componente do array que bater em qualquer um dos três tipos vence").
 *  - `pickFirstCandidate`: o servidor usa o default (primeiro candidato
 *    vence) para este campo — `extractNeighborhoodFromLocation` não passa
 *    `pickCandidate` customizado.
 *  - `allowFormattedFallback=false`: o servidor desliga o fallback por
 *    `formatted_address` para este campo (comentário no código-fonte: cairia
 *    no nome da rua, que é o 1º segmento por vírgula). Como o parâmetro é
 *    `false`, o branch de fallback do servidor é MORTO para este campo —
 *    por isso ele nem está portado aqui; portar código morto criaria uma
 *    divergência potencial (bug introduzido do lado de cá) sem nenhum ganho
 *    de paridade.
 *  - `cleanNullLiteral`: mesmo comportamento (trim; `''`/`'null'` → null).
 *
 * Formato de entrada: `address_components` como o widget legado
 * `google.maps.places.Autocomplete` devolve (`long_name`, `short_name`,
 * `types`) — é o MESMO formato de objeto que o location do ClickUp usa no
 * servidor, então a porta não precisa adaptar forma, só a chamada.
 */

/** Subconjunto de `google.maps.GeocoderAddressComponent` que a função usa. */
export interface PatientZoneAddressComponent {
  long_name?: string;
  short_name?: string;
  types: string[];
}

/** Espelha `collectAddressComponentCandidates` de locationHelpers.ts. */
function collectAddressComponentCandidates(
  components: PatientZoneAddressComponent[] | null | undefined,
  componentTypes: string[],
): string[] {
  if (!Array.isArray(components)) return [];
  const candidates: string[] = [];
  for (const comp of components) {
    const types = comp?.types;
    if (!Array.isArray(types)) continue;
    const hasType = componentTypes.some((t) => types.includes(t));
    if (hasType) {
      const name = comp.long_name ?? comp.short_name;
      if (typeof name === 'string' && name.trim()) candidates.push(name.trim());
    }
  }
  return candidates;
}

/** Espelha `cleanNullLiteral` de argentinaLocationNormalizer.ts (worker-functions). */
function cleanNullLiteral(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null') return null;
  return trimmed;
}

/**
 * Deriva a Zona/Barrio a partir dos `address_components` de uma escolha do
 * Google Places — mesma regra que `extractNeighborhoodFromLocation` no
 * servidor: `sublocality_level_1` → `sublocality` → `neighborhood`,
 * primeiro componente do array (na ordem em que veio) que bater em qualquer
 * um dos três tipos. `null` quando nenhum componente bate.
 */
export function derivePatientZone(
  addressComponents: PatientZoneAddressComponent[] | null | undefined,
): string | null {
  const candidates = collectAddressComponentCandidates(addressComponents, [
    'sublocality_level_1',
    'sublocality',
    'neighborhood',
  ]);
  return cleanNullLiteral(candidates[0] ?? null);
}
