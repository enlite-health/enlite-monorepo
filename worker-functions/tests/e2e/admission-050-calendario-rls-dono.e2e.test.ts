/**
 * spec 050 F10 (complemento) — o CONTROLE: os mesmos cenários pela conexão do DONO do banco (bypassa RLS) também passam.
 * Sem ele, um verde do `-runtime` não diz que o cenário mede o que deve.
 */
import { definirCenariosCalendarioRls } from './helpers/admissionCalendarRlsHarness';

definirCenariosCalendarioRls('dono', 'cd1');
