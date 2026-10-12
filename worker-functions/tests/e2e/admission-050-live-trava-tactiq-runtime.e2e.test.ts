/**
 * spec 050 F27 (R-53) — uma leitura do Tactiq por vez por responsável, conexão: runtime.
 * Os cenários vivem em `helpers/admissionTravaTactiqHarness.ts`; o par é `admission-050-live-trava-tactiq-dono`.
 */
import { definirCenariosTravaTactiq } from './helpers/admissionTravaTactiqHarness';

definirCenariosTravaTactiq('runtime', 'f27r');
