/**
 * Leituras e staff mock mínimos que os e2e do lançamento da vaga (cadeia Fase 6) usam.
 * Rota rb da spec 033: os helpers originais (`funnel-move-e2e-helper`, `compativeis-e2e-helper`,
 * `vacancy-notes-e2e-helper`) pertencem às Fases 3/4/5, que NÃO vão à main; só estas 4 funções
 * triviais foram copiadas (rotas GET /api/admin/patients/:id e /vacancies/:id/funnel já existem
 * na main). A URL do backend é lida dentro da função, nunca no import.
 */
import type { APIRequestContext } from '@playwright/test';
import { runSQL } from './patient-detail-a-helper';
import type { MockUser } from './abac-stack-helper';

function backend(): string {
  return process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
}

/** `GET /api/admin/patients/:id` — devolve só `status`. */
export async function readPatientStatusApi(
  request: APIRequestContext,
  backendUrl: string,
  token: string,
  patientId: string,
): Promise<string | null> {
  const res = await request.get(`${backendUrl}/api/admin/patients/${patientId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    throw new Error(`GET /api/admin/patients/${patientId} falhou: ${res.status()}`);
  }
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

/** `GET /api/admin/vacancies/:id/funnel` — devolve o `data` cru da resposta. */
export async function readFunnelApi(request: APIRequestContext, token: string, vacancyId: string): Promise<unknown> {
  const res = await request.get(`${backend()}/api/admin/vacancies/${vacancyId}/funnel`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  return body?.data;
}

export function seedMockStaff(u: MockUser, displayName: string): void {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status) ` +
      `VALUES ('${u.uid}', '${u.email}', '${displayName.replace(/'/g, "''")}', 'admin', true, 'staff', 'ACTIVE') ` +
      `ON CONFLICT (firebase_uid) DO NOTHING`,
  );
}

export function cleanupMockStaff(u: MockUser): void {
  runSQL(`DELETE FROM users WHERE firebase_uid = '${u.uid}'`);
}
