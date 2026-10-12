/**
 * spec 050 F26 — o job de 1 minuto pela rota HTTP real, com a conexão `dono`. Os cenários vivem em
 * `helpers/admissionLiveJobHarness.ts`; o par é `admission-050-live-job-runtime`.
 */
import { definirCenariosJobVivo } from './helpers/admissionLiveJobHarness';

definirCenariosJobVivo('dono', 'f26a');
