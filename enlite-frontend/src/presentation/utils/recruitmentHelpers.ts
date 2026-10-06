import { formatWallDate } from '@presentation/utils/dateTimeFormat';

/**
 * Recruitment Dashboard Data Processing Helpers
 * Migrated from Dashboard Reclutamiento - handles data normalization, parsing, and extraction
 */

/**
 * Normalizes an array of objects by converting all keys to lowercase and trimming them.
 */
export function normalizeData<T extends Record<string, string>>(
  data: T[],
  defaultCaso?: string
): Record<string, string>[] {
  return data.map((row) => {
    const normalized: Record<string, string> = {};
    for (const key in row) {
      if (key) {
        normalized[key.toLowerCase().trim()] = String(row[key] || '').trim();
      }
    }
    if (defaultCaso && !normalized['caso'] && !normalized['id caso']) {
      normalized['caso'] = defaultCaso;
    }
    return normalized;
  });
}

/**
 * Finds the first key in an array of objects that matches any of the provided possible keys.
 */
export function getMatchingKey(
  data: Record<string, string>[],
  possibleNames: string[]
): string | null {
  if (!data || data.length === 0) return null;
  const allKeys = new Set<string>();
  const maxRows = Math.min(data.length, 1000);
  for (let i = 0; i < maxRows; i++) {
    if (data[i]) {
      Object.keys(data[i]).forEach((k) => allKeys.add(k));
    }
  }

  for (const name of possibleNames) {
    const target = name.toLowerCase().trim();
    for (const key of allKeys) {
      if (key === target) return key;
    }
  }
  for (const name of possibleNames) {
    const target = name.toLowerCase().trim();
    for (const key of allKeys) {
      if (key.includes(target)) return key;
    }
  }
  return null;
}

/**
 * Formats a phone number into a natural integer format.
 */
export function formatPhone(val: string): string {
  if (!val) return '';
  let raw = val.trim();

  if (/[eE]/.test(raw) || /\./.test(raw)) {
    const num = Number(raw);
    if (!isNaN(num)) {
      raw = num.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 0 });
    }
  }

  let digits = raw.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }

  if (digits === '') return '-';
  return digits;
}

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

/**
 * Extracts all numeric sequences from a string.
 */
export function extractNumbers(str: string): string[] {
  const matches = str.match(/\d+/g);
  return matches ? matches : [];
}

/**
 * Extracts case numbers from the Talentum 'Pre screenings' column.
 * Only matches entries in the format 'CASO NNN' or 'CASO NNN (...)',
 * ignoring free-text entries.
 */
export function extractCaseNumbersFromPreScreenings(str: string): string[] {
  const results: string[] = [];
  const matches = str.matchAll(/\bCASO\s+(\d+)/gi);
  for (const m of matches) {
    results.push(m[1]);
  }

  if (results.length === 0) {
    if (/^[\d\s,.\-;&y]+$/.test(str.trim())) {
      const nums = str.match(/\d+/g);
      if (nums) results.push(...nums);
    } else {
      const nums = str.match(/\b(\d{3,4})\b/g);
      if (nums && !/[a-zA-Z]{3,}/.test(str)) {
        results.push(...nums);
      }
    }
  }

  return [...new Set(results)];
}

/**
 * Formats a ClickUp date string into a human-readable format.
 */
export function formatClickUpDate(val: string): string {
  if (!val || !val.trim()) return '';
  const str = val.trim();

  const parsed = parseDate(str);
  if (!isNaN(parsed.getTime())) {
    // `parseDate` monta a Date com o relógio LOCAL (planilha sem fuso): SÓ-DATA, sem conversão.
    const datePart = formatWallDate(parsed, { day: 'numeric', month: 'short', year: 'numeric' }) ?? str;
    const timeMatch = str.match(/(\d{2}):(\d{2})(?::\d{2})?$/);
    return timeMatch ? `${datePart}, ${timeMatch[1]}:${timeMatch[2]}` : datePart;
  }

  return str;
}

/**
 * Parses a date from a string or Excel serial number.
 */
export function parseDate(val: string | number): Date {
  if (val === undefined || val === null || val === '') return new Date(NaN);

  const num = Number(val);
  if (!isNaN(num) && num > 20000 && num < 100000) {
    const utcDate = new Date(Math.round((num - 25569) * 86400 * 1000));
    return new Date(
      utcDate.getUTCFullYear(),
      utcDate.getUTCMonth(),
      utcDate.getUTCDate(),
      utcDate.getUTCHours(),
      utcDate.getUTCMinutes(),
      utcDate.getUTCSeconds()
    );
  }

  const str = String(val).trim();

  const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (dmyMatch) {
    const [, dd, mm, yy] = dmyMatch;
    const yyyy = yy.length === 2 ? `20${yy}` : yy;
    const d = parseInt(dd, 10),
      m = parseInt(mm, 10),
      y = parseInt(yyyy, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const result = new Date(y, m - 1, d, 0, 0, 0);
      if (!isNaN(result.getTime())) return result;
    }
  }

  const ymdMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymdMatch) {
    const [, yyyy, mm, dd] = ymdMatch;
    const d = parseInt(dd, 10),
      m = parseInt(mm, 10),
      y = parseInt(yyyy, 10);
    const result = new Date(y, m - 1, d, 0, 0, 0);
    if (!isNaN(result.getTime())) return result;
  }

  return new Date(str);
}

/**
 * Returns a human-readable string representing the time elapsed since the given date.
 */
export function getTimeAgo(date: Date): string {
  if (isNaN(date.getTime())) return '-';
  const now = new Date();
  const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d2 = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffTime = d1.getTime() - d2.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return 'En el futuro';
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 30) return `Hace ${diffDays} días`;
  if (diffDays < 60) return 'Hace 1 mes';
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `Hace ${diffMonths} meses`;
  const diffYears = Math.floor(diffDays / 365);
  return `Hace ${diffYears} año${diffYears > 1 ? 's' : ''}`;
}

/**
 * Normalizes input and returns true for positive attendance marks.
 */
export function isAsistente(val: string): boolean {
  if (!val) return false;
  const v = val.toLowerCase().trim();
  return (
    v === 'true' ||
    v === 'sí' ||
    v === 'si' ||
    v === 'yes' ||
    v === 'check' ||
    v === '✓' ||
    v === '✔'
  );
}
