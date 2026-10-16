/**
 * spec 050 F26 — o job de 1 minuto pela rota HTTP real, com a conexão `runtime`. Os cenários vivem em
 * `helpers/admissionLiveJobHarness.ts`; o par é `admission-050-live-job-dono`.
 */
import { definirCenariosJobVivo } from './helpers/admissionLiveJobHarness';

definirCenariosJobVivo('runtime', 'f26b');
