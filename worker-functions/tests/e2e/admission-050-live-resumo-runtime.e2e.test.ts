/** spec 050 F28 — o gatilho do resumo pelas rotas HTTP reais, conexão `runtime` (login `app_runtime` + pool `app_system`, RLS ligada, como a stage). O par é `-dono`. */
import { definirCenariosResumo } from './helpers/admissionLiveResumoCenarios';

definirCenariosResumo('runtime', 'f28b');
