/**
 * spec 050 F7, R-31 — o CONTROLE do A7-2: os mesmos pedidos pela conexão do DONO do banco (bypassa RLS) NÃO devolvem 404.
 * Sem este arquivo, o 404 do `admission-050-pais-runtime` poderia vir de qualquer outra causa.
 */
import { definirCenariosPais } from './helpers/admissionPaisHarness';

definirCenariosPais('dono', 'dn7');
