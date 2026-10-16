import { countryToTimezone } from '@shared/locale/CountryTimezone';

/** Data da reunião em ISO (AAAA-MM-DD) no fuso do país — o `fecha` que o Gem pede. */
export function isoDateLabel(slotStart: Date, country: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: countryToTimezone(country), year: 'numeric', month: '2-digit', day: '2-digit' }).format(slotStart);
}

/** Data da reunião (DD/MM/AAAA, es-AR) no fuso do país — o rótulo do PDF. */
export function dateLabel(slotStart: Date, country: string): string {
  return new Intl.DateTimeFormat('es-AR', { timeZone: countryToTimezone(country), day: '2-digit', month: '2-digit', year: 'numeric' }).format(slotStart);
}
