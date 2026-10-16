/**
 * spec 050 F29 (A29-2) — o andamento da reunião na lista da aba, conexão: dono.
 * Os cenários vivem em `helpers/admissionAndamentoHarness.ts`; o outro arquivo do par é o papel do runtime (RLS ligada).
 */
import { definirCenariosAndamento } from './helpers/admissionAndamentoHarness';

definirCenariosAndamento('dono', 'an2');
