/**
 * vagaEstadoPacienteApp — o app REAL (rotas da ficha do paciente + rotas de vaga + a página pública da vaga) com o engine de permissão LIGADO,
 * numa porta efêmera, para `vaga-mostra-estado-do-paciente.e2e.test.ts` (estado-automatico-do-paciente, F2). Sem `jest.mock`: cadeia de
 * middlewares, controllers e banco reais. O stack do CI sobe a API com o engine DESLIGADO (cells === null); a prova por célula (`patient:read`)
 * monta o app aqui, como as outras suítes de família (molde `contrato058aApp.ts`).
 * ⚠️ As envs são escritas ANTES do primeiro `import()` de `src/` (ver permissionFamilyHarness).
 */
import { montarAppDeFamilia, type AppDeFamilia } from './permissionFamilyHarness';

export { atorComCelulas, limparAtores, chamar, type Celula } from './contrato058aApp';

const envAnterior: Record<string, string | undefined> = {};
const setEnv = (k: string, v: string): void => { envAnterior[k] = process.env[k]; process.env[k] = v; };

export async function subirAppVaga(databaseUrl: string): Promise<AppDeFamilia> {
  setEnv('USE_MOCK_AUTH', 'true');
  setEnv('PERMISSION_ENGINE_ENABLED', 'true');
  setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.vacancies');
  setEnv('PERMISSION_CACHE_TTL_MS', '0');
  setEnv('DATABASE_URL', databaseUrl);
  const caseModule = await import('@modules/case');
  const matching = await import('@modules/matching');
  const { AdminPatientDiagnosesController } = await import('@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController');
  const { AdminTerminologySearchController } = await import('@modules/terminology/interfaces/controllers/AdminTerminologySearchController');
  const naoUsado = {} as never; // controllers que estas rotas não exercem: o router só os desreferencia dentro do handler
  return montarAppDeFamilia({
    enforcedRoutes: 'admin.patients;admin.vacancies',
    montarRotas: ({ app, auth, permissions }) => {
      app.use(
        '/api/admin',
        caseModule.createAdminPatientsRoutes(
          new caseModule.AdminPatientsController(), auth, permissions,
          new caseModule.AdminPatientChatIdsController(), new caseModule.AdminPatientChatRolesController(), new caseModule.AdminPatientsMapController(),
          new caseModule.AdminPatientAddressesController(), new caseModule.AdminInsuranceProvidersController(), new caseModule.AdminPatientContractedServicesController(),
          new AdminPatientDiagnosesController(), new AdminTerminologySearchController(),
        ),
      );
      app.use(
        '/api/admin',
        matching.createAdminVacanciesRoutes(
          new matching.VacanciesController(), new matching.VacancyCrudController(), naoUsado, naoUsado, naoUsado, naoUsado, naoUsado, naoUsado,
          auth, permissions, naoUsado, naoUsado,
        ),
      );
      // A página pública da vaga (sem auth), a MESMA função que o `src/index.ts` liga em `/api/vacancies/:id`.
      const publica = new matching.PublicVacancyController();
      app.get('/api/vacancies/:id', (req, res) => { void publica.getById(req, res); });
    },
  });
}

export async function fecharAppVaga(app: AppDeFamilia | undefined): Promise<void> {
  await app?.fechar();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  for (const [k, v] of Object.entries(envAnterior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
