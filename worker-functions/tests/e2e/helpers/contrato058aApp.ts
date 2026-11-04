/**
 * contrato058aApp — o app REAL (rotas da ficha + rotas de obra social/contrato/vínculo) com o engine de permissão LIGADO, numa porta efêmera,
 * para as suítes 058a que provam REDAÇÃO POR CÉLULA (T093) e ficha × rota (T094). Sem `jest.mock`: cadeia de middlewares, controllers e banco reais.
 * O stack do CI sobe a API com o engine DESLIGADO (cells === null); por isso a prova por célula monta o app aqui, como as outras suítes de família.
 * ⚠️ As envs são escritas ANTES do primeiro `import()` de `src/` (ver permissionFamilyHarness).
 */
import type { Pool } from 'pg';
import { montarAppDeFamilia, tokenMock, grupoComCelulas, garantirCelula, limparIamFixtures, TENANT_E2E, type AppDeFamilia } from './permissionFamilyHarness';

export { tokenMock, TENANT_E2E };
export type Celula = [string, string];

/** Tudo o que a ficha + a rota de serviços + a cascata + o cadastro de obra social leem/gravam. */
export const CELULAS_TODAS: Celula[] = [
  ['patient', 'read'], ['patient', 'create'], ['patient_services', 'read'], ['patient_services', 'create'], ['patient_services', 'update'],
  ['patient_coverage', 'read'], ['patient_coverage', 'update'], ['patient_contract_value', 'read'], ['patient_contract_value', 'create'],
  ['catalog_insurance_providers', 'read'], ['catalog_insurance_providers', 'create'], ['catalog_insurance_providers', 'update'],
  ['insurance_provider_contacts', 'read'], ['insurance_provider_contacts', 'create'], ['insurance_provider_contacts', 'update'],
  ['insurance_contracts', 'read'], ['insurance_contracts', 'create'], ['insurance_contracts', 'update'], ['insurance_provider_patients', 'read'],
];
export const sem = (...fora: string[]): Celula[] => CELULAS_TODAS.filter(([r, a]) => !fora.includes(`${r}:${a}`));

const envAnterior: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

export async function subirApp058a(databaseUrl: string): Promise<AppDeFamilia> {
  setEnv('USE_MOCK_AUTH', 'true');
  setEnv('PERMISSION_ENGINE_ENABLED', 'true');
  setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
  setEnv('PERMISSION_CACHE_TTL_MS', '0');
  setEnv('DATABASE_URL', databaseUrl);
  const caseModule = await import('@modules/case');
  const { AdminPatientDiagnosesController } = await import('@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController');
  const { AdminTerminologySearchController } = await import('@modules/terminology/interfaces/controllers/AdminTerminologySearchController');
  return montarAppDeFamilia({
    enforcedRoutes: 'admin.patients',
    montarRotas: ({ app, auth, permissions }) => {
      const providers = new caseModule.AdminInsuranceProvidersController();
      app.use(
        '/api/admin',
        caseModule.createAdminPatientsRoutes(
          new caseModule.AdminPatientsController(), auth, permissions,
          new caseModule.AdminPatientChatIdsController(), new caseModule.AdminPatientChatRolesController(), new caseModule.AdminPatientsMapController(),
          new caseModule.AdminPatientAddressesController(), providers, new caseModule.AdminPatientContractedServicesController(),
          new AdminPatientDiagnosesController(), new AdminTerminologySearchController(),
        ),
      );
      app.use(
        '/api/admin',
        caseModule.createAdminInsuranceRoutes(
          auth, permissions, providers, new caseModule.AdminInsuranceProviderContactsController(),
          new caseModule.AdminInsuranceContractsController(), new caseModule.AdminContractedServiceContractLinkController(),
        ),
      );
    },
  });
}

export async function fecharApp058a(app: AppDeFamilia | undefined): Promise<void> {
  await app?.fechar();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  for (const [k, v] of Object.entries(envAnterior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

/** Staff `admin` (papel) com um grupo de EXATAMENTE essas células — o papel não decide nada com o engine ligado. */
export async function atorComCelulas(pool: Pool, uid: string, nome: string, celulas: Celula[]): Promise<void> {
  await pool.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES ($1, $2, $3, 'admin', 'ACTIVE', true, $4)
     ON CONFLICT (firebase_uid) DO NOTHING`,
    [uid, `${uid}@e2e.local`, nome, TENANT_E2E],
  );
  // Catálogo do banco de teste: o sync de catálogo só roda com a flag; célula que o seed não tem entra aqui (ON CONFLICT DO NOTHING, nunca apagada).
  for (const [resource, action] of celulas) await garantirCelula(pool, { resource, action, category: 'Pacientes' });
  await grupoComCelulas(pool, { nome, uid, celulas });
}

export async function limparAtores(pool: Pool, atores: Array<{ uid: string; nome: string }>): Promise<void> {
  await limparIamFixtures(pool, { uids: atores.map((a) => a.uid), grupos: atores.map((a) => a.nome) });
}

export async function chamar(app: AppDeFamilia, metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${app.url}${caminho}`, {
    method: metodo,
    headers: { Authorization: tokenMock(uid, 'admin', 'AR'), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
