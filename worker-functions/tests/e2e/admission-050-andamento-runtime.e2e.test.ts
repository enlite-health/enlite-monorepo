/**
 * spec 050 F29 (A29-2) — o andamento da reunião na lista da aba, conexão: runtime.
 * Os cenários vivem em `helpers/admissionAndamentoHarness.ts`; o outro arquivo do par é o controle com a conexão do dono.
 */
import { definirCenariosAndamento } from './helpers/admissionAndamentoHarness';

definirCenariosAndamento('runtime', 'an1');
