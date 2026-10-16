/**
 * spec 050 F11 — "Reintentar resumen" com o PAPEL DO RUNTIME (`app_runtime` + pool de sistema `app_system`) e o engine de permissão ligado.
 * Os cenários vivem em `helpers/admissionRetryHarness.ts`; o controle com a conexão do dono é `admission-050-resumo-retry-dono`.
 */
import { definirCenariosResumoRetry } from './helpers/admissionRetryHarness';

definirCenariosResumoRetry('runtime', 'rr1');
