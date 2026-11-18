/**
 * patientCountryScopeGuard — PONTO UNICO de checagem de pais para tudo sob `/patients/:id/*` e
 * `/patients/:patientId/*`. Fabrica generica: `requireRecordInCountryScope` (identity) — ver la a regra e o porque.
 * Fora do escopo => 404 "Patient not found" (o mesmo corpo do handler para inexistente).
 */
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { requireRecordInCountryScope } from '@modules/identity';

export function requirePatientInCountryScope(getPool: () => Pool): RequestHandler {
  return requireRecordInCountryScope(getPool, {
    table: 'patients',
    idParams: ['id', 'patientId'],
    notFoundBody: { success: false, error: 'Patient not found' },
  });
}
