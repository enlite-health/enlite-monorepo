/**
 * spec 050 F15 (R-1, R-2, R-3, R-5, R-6) — relatório do Chrome com o PAPEL DO RUNTIME (`app_runtime` + pool de sistema `app_system`).
 * Os cenários vivem em `helpers/admissionChromeReportHarness.ts`; o controle com a conexão do dono é `admission-050-chrome-report-dono`.
 */
import { definirCenariosRelatorioChrome } from './helpers/admissionChromeReportHarness';

definirCenariosRelatorioChrome('runtime', 'cr1');
