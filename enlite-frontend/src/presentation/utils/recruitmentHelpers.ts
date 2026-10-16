/**
 * Formats a phone number for display with regional formatting.
 * Argentina (54, 13 digits): +54 9 XX XXXX-XXXX
 * Brazil (55, 13 digits): +55 (XX) XXXXX-XXXX
 * Other (8+ digits): +XXXXX...
 */
export function formatPhoneDisplay(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('54')) {
    return `+54 9 ${digits.slice(3, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length >= 8) return `+${digits}`;
  return raw;
}
