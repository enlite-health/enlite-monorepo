/**
 * spec 050 F14 (R-7) — início real da reunião com o PAPEL DO RUNTIME (`app_runtime` + pool de sistema `app_system`).
 * Os cenários vivem em `helpers/admissionInicioRealHarness.ts`; o controle com a conexão do dono é `admission-050-inicio-real-dono`.
 */
import { definirCenariosInicioReal } from './helpers/admissionInicioRealHarness';

definirCenariosInicioReal('runtime', 'ir1');
