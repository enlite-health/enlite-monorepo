/**
 * spec 050 F14 (R-7) — o CONTROLE: os mesmos cenários pela conexão do DONO do banco (bypassa RLS) também passam.
 * Sem ele, um verde do `-runtime` não diz que o cenário mede o que deve.
 */
import { definirCenariosInicioReal } from './helpers/admissionInicioRealHarness';

definirCenariosInicioReal('dono', 'id1');
