/**
 * spec 050 F27 (R-53) — uma leitura do Tactiq por vez por responsável, conexão: dono.
 * Os cenários vivem em `helpers/admissionTravaTactiqHarness.ts`; o par é `admission-050-live-trava-tactiq-runtime`.
 */
import { definirCenariosTravaTactiq } from './helpers/admissionTravaTactiqHarness';

definirCenariosTravaTactiq('dono', 'f27d');
