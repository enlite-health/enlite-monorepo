const COUNTRY_TIMEZONE_MAP: Record<string, string> = {
  AR: 'America/Argentina/Buenos_Aires',
  BR: 'America/Sao_Paulo',
};

export function countryToTimezone(country: string): string {
  return COUNTRY_TIMEZONE_MAP[country] ?? 'UTC';
}
