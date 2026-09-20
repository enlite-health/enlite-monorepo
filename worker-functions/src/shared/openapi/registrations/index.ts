// Side-effect imports — cada módulo registra suas rotas no `registry` singleton.
// Adicionar uma nova rota? Crie/edite o arquivo do módulo e importe aqui.
// O teste de cobertura Playwright FALHA se uma rota Express não tiver registro.

import './health';
import './adminAuth';
import './adminDashboard';
import './adminEncuadres';
import './adminFunnel';
import './adminInterviewSlots';
import './adminMatching';
import './adminMessaging';
import './adminPatients';
import './adminRecruitment';
import './adminSetup';
import './adminSocialLinks';
import './adminMeetLinks';
import './adminTalentum';
import './adminUsers';
import './permissionsPanel';
import './adminVacancies';
import './adminWorkerDocuments';
import './adminWorkers';
import './analytics';
import './internalEvents';
import './internalMessaging';
import './internalOutbox';
import './internalReminders';
import './internalWebhooks';
import './publicJobs';
import './publicVacancies';
import './user';
import './webhooksTalentum';
import './webhooksTest';
import './webhooksTwilio';
import './worker';
import './workerApplications';
import './workerDocuments';
import './workerJobs';
import './workerStatus';
