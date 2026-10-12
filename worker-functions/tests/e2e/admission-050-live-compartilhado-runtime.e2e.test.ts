/**
 * spec 050 F25 (R-48, R-54) — o que os dois jobs compartilham, com a conexão `runtime`. Os cenários vivem em
 * `helpers/admissionLiveCompartilhadoHarness.ts`; o par é `admission-050-live-compartilhado-dono`.
 */
import { definirCenariosLiveCompartilhado } from './helpers/admissionLiveCompartilhadoHarness';

definirCenariosLiveCompartilhado('runtime', 'l1');
