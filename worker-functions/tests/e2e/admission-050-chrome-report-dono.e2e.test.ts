/**
 * spec 050 F15 — o CONTROLE: os mesmos cenários pela conexão do DONO do banco (bypassa RLS) também passam.
 * Sem ele, um verde do `-runtime` não diz que o cenário mede o que deve.
 */
import { definirCenariosRelatorioChrome } from './helpers/admissionChromeReportHarness';

definirCenariosRelatorioChrome('dono', 'cd1');
