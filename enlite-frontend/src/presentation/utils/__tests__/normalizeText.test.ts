import { describe, it, expect } from 'vitest';
import { normalizeText } from '../normalizeText';

describe('normalizeText', () => {
  it('minúsculas', () => {
    expect(normalizeText('ABC')).toBe('abc');
  });

  it('remove diacrítico (á, é, í, ó, ú, ñ)', () => {
    expect(normalizeText('Gestión a la Vista')).toBe('gestion a la vista');
    expect(normalizeText('Mensajería')).toBe('mensajeria');
    expect(normalizeText('Dirección')).toBe('direccion');
    expect(normalizeText('Diagnóstico')).toBe('diagnostico');
    expect(normalizeText('Preselección')).toBe('preseleccion');
    expect(normalizeText('Números clave')).toBe('numeros clave');
    expect(normalizeText('Analítica')).toBe('analitica');
    expect(normalizeText('Importación')).toBe('importacion');
    expect(normalizeText('Año')).toBe('ano');
  });

  it('texto sem diacrítico não muda além do minúsculo', () => {
    expect(normalizeText('patient_family:read')).toBe('patient_family:read');
  });

  it('string vazia', () => {
    expect(normalizeText('')).toBe('');
  });
});
