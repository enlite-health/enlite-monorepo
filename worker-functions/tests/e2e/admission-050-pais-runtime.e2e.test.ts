/**
 * spec 050 F7, R-31 — A7-2 com o PAPEL DO RUNTIME (login membro de `app_runtime`, RLS de país ligado).
 * Os cenários vivem em `helpers/admissionPaisHarness.ts`; o controle com a conexão do dono é `admission-050-pais-dono.e2e.test.ts`.
 */
import { definirCenariosPais } from './helpers/admissionPaisHarness';

definirCenariosPais('runtime', 'rt7');
