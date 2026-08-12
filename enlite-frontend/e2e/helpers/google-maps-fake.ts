/**
 * google-maps-fake.ts
 *
 * Injects a fake `window.google.maps.places.Autocomplete` so the real
 * GooglePlacesAutocomplete component works in tests WITHOUT loading the
 * Google Maps JS API (external, billed, non-deterministic).
 *
 * The component (GooglePlacesAutocomplete.tsx) short-circuits its script
 * loader when `window.google.maps.places.Autocomplete` already exists, so
 * installing this via addInitScript (before navigation) is enough.
 *
 * Behaviour: typing >3 chars into the bound input fires a synthetic
 * `place_changed` event whose getPlace() returns a CABA address with
 * geometry — exactly what the component needs to mark the address valid
 * and trigger the autosave PUT /api/workers/me/service-area.
 *
 * Mirrors the inline GOOGLE_FAKE in staging-journey-clean.e2e.ts (shared
 * here to avoid duplication).
 */

import { type Page } from '@playwright/test';

export const GOOGLE_MAPS_FAKE_SCRIPT = `
window.google = { maps: { places: { Autocomplete: class {
  constructor(input){ this.input=input; this._cb=null;
    input.addEventListener('input',()=>{ if(this._cb && input.value.length>3) setTimeout(()=>this._cb(),50); }); }
  addListener(ev,cb){ if(ev==='place_changed') this._cb=cb; }
  getPlace(){ return { formatted_address:'Av. Corrientes 1234, Buenos Aires', name:'Av. Corrientes 1234',
    geometry:{ location:{ lat:()=>-34.6037, lng:()=>-58.3816 } },
    address_components:[{long_name:'Av. Corrientes',short_name:'Av. Corrientes',types:['route']},
      {long_name:'1234',short_name:'1234',types:['street_number']},
      {long_name:'Buenos Aires',short_name:'CABA',types:['locality']},
      {long_name:'CABA',short_name:'CABA',types:['administrative_area_level_1']},
      {long_name:'Argentina',short_name:'AR',types:['country']}] }; } } },
  event:{ clearInstanceListeners:()=>{} } } };
`;

/** Installs the Google Maps fake on every page load/navigation. Call before goto. */
export async function installGoogleMapsFake(page: Page): Promise<void> {
  await page.addInitScript(GOOGLE_MAPS_FAKE_SCRIPT);
}
