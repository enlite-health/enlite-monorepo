/**
 * deriveBillingLocality — cidade e província do endereço de FATURAMENTO a partir dos
 * `address_components` de uma escolha do Google Places (spec 044, P3). Irmão de `derivePatientZone`.
 *
 * Regra (a spec nomeou exatamente estes dois tipos, sem fallback para outros):
 *   - cidade    = primeiro componente com o tipo `locality`;
 *   - província = primeiro componente com o tipo `administrative_area_level_1`;
 *   - nome      = `long_name ?? short_name` (aparado); componente ausente ou sem nome → `null`.
 * `geometry` é ignorada: faturamento não usa coordenada, e o servidor não deriva nada disto.
 */
import type { PatientZoneAddressComponent } from './derivePatientZone';

export interface BillingLocality {
  city: string | null;
  province: string | null;
}

function nameOfFirst(
  components: PatientZoneAddressComponent[],
  type: string,
): string | null {
  for (const comp of components) {
    if (!Array.isArray(comp?.types) || !comp.types.includes(type)) continue;
    const name = comp.long_name ?? comp.short_name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return null;
}

export function deriveBillingLocality(
  addressComponents: PatientZoneAddressComponent[] | null | undefined,
): BillingLocality {
  if (!Array.isArray(addressComponents)) return { city: null, province: null };
  return {
    city: nameOfFirst(addressComponents, 'locality'),
    province: nameOfFirst(addressComponents, 'administrative_area_level_1'),
  };
}
