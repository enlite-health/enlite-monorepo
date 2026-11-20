/**
 * respondCountryScope — traducao UNICA de `resolveCountryScope` para HTTP, para controllers que precisam do escopo
 * antes de consultar. Mesmo contrato de getPatientStats: `CountryScopeError` => status/code do erro (403
 * COUNTRY_SCOPE_REQUIRED ou 400 INVALID_COUNTRY); qualquer outra falha => 500 fechado. Devolve `null` quando JA
 * respondeu (o chamador so faz `return`); nunca devolve "todos".
 */
import type { Response } from 'express';
import type { Pool } from 'pg';
import { resolveCountryScope, CountryScopeError } from '../../application/resolveCountryScope';
import type { CountryCode } from '@shared/domain/countryCodes';
import { currentDbContext } from '@shared/database/requestDbSession';
import { reportError } from '@shared/logging';

export async function resolveCountriesOrRespond(
  db: Pool,
  res: Response,
  requested: unknown,
  source: string,
): Promise<CountryCode[] | null> {
  try {
    return (await resolveCountryScope(db, currentDbContext()?.uid, requested)).countries;
  } catch (err) {
    if (err instanceof CountryScopeError) {
      res.status(err.status).json({ success: false, error: err.code, detail: err.message });
      return null;
    }
    reportError(err instanceof Error ? err : new Error(String(err)), { source: `${source}:scope` });
    res.status(500).json({ success: false, error: 'Failed to resolve country scope' });
    return null;
  }
}
