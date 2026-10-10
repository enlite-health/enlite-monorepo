/**
 * spec 050 F10 (complemento) — as varreduras do job e a compensação da F9 com o PAPEL DO RUNTIME (`app_runtime` + pool de sistema).
 * Os cenários vivem em `helpers/admissionCalendarRlsHarness.ts`; o controle com a conexão do dono é `admission-050-calendario-rls-dono`.
 */
import { definirCenariosCalendarioRls } from './helpers/admissionCalendarRlsHarness';

definirCenariosCalendarioRls('runtime', 'cr1');
