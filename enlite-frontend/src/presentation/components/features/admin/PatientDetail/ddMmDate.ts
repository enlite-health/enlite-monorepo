/** `YYYY-MM-DD` → `dd/mm/aaaa` pelos componentes da STRING (nunca por `Date`: UTC rola o dia). */
export function formatDdMmYyyy(dateIso: string): string {
  const [year, month, day] = dateIso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : '';
}
