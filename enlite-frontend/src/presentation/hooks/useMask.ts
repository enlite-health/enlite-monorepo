import { useCallback } from 'react';

/**
 * Hook para aplicar máscaras em inputs de texto
 * @param mask - Padrão da máscara (ex: '##/##/####' para data DD/MM/AAAA)
 * @returns Função para aplicar a máscara
 */
export function useMask(mask: string): (value: string) => string {
  return useCallback((value: string) => {
    if (!value) return '';

    const digits = value.replace(/\D/g, '');
    let result = '';
    let digitIndex = 0;

    for (let i = 0; i < mask.length && digitIndex < digits.length; i++) {
      if (mask[i] === '#') {
        result += digits[digitIndex];
        digitIndex++;
      } else {
        result += mask[i];
      }
    }

    return result;
  }, [mask]);
}

/**
 * Aplica máscara de data DD/MM/AAAA
 */
export function maskDate(value: string): string {
  if (!value) return '';

  const digits = value.replace(/\D/g, '').slice(0, 8);

  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;

  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
}

/**
 * Remove todos os caracteres não numéricos
 */
export function unmask(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Aplica máscara de CUIL/CUIT: XX-XXXXXXXX-X
 */
export function maskCuilCuit(value: string): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 10) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10, 11)}`;
}

/**
 * Aplica máscara de CPF: XXX.XXX.XXX-XX
 */
export function maskCpf(value: string): string {
  if (!value) return '';
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9, 11)}`;
}

/**
 * Converte data DD/MM/AAAA para AAAA-MM-DD (formato ISO)
 */
export function parseDateToISO(value: string): string {
  const digits = unmask(value);
  if (digits.length !== 8) return value;

  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);

  return `${year}-${month}-${day}`;
}

/**
 * Valida se uma data no formato DD/MM/AAAA é uma data real, completa e não
 * futura — o gate que `generalInfoSchema.birthDate` usa antes do submit.
 *
 * Defeito 1 (21/09/2026): `maskDate` + `parseDateToISO` sozinhos não bastam —
 * entrada incompleta (ex.: usuário digita "25/3/1985", só 7 dígitos úteis)
 * faz `maskDate` agrupar errado ("25/31/985"), e sem este gate esse lixo
 * seguia até o backend como string.
 */
export function isValidBirthDateBr(value: string): boolean {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return false;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900) return false;

  // Round-trip pelo Date: pega mês/dia que "transbordam" (ex.: 31/04 vira 01/05).
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return false;
  }

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (date > today) return false;

  return true;
}

/**
 * Converte data AAAA-MM-DD para DD/MM/AAAA
 */
export function formatDateFromISO(value: string): string {
  if (!value || value.length < 10) return value;

  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;

  return `${match[3]}/${match[2]}/${match[1]}`;
}
