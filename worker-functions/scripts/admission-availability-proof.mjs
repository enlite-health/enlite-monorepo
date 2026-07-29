// Prova com DADO REAL do layer de calendário do agendador de admissão.
//
// Usa o fallback de assinatura local do DWD → precisa de
// GOOGLE_APPLICATION_CREDENTIALS apontando pra chave da SA
// enlite-functions-sa@enlite-prd.
//
//   GOOGLE_APPLICATION_CREDENTIALS=.keys/enlite-prd-e7b9624315e8.json \
//     node scripts/admission-availability-proof.mjs
//
// Chama getBusyIntervals + computeFreeSlots pros 2 hosts nos próximos 3 dias
// úteis e imprime os slots (horário AR + quais hosts livres). NÃO cria evento.
//
// Carrega o service TS via ts-node (CommonJS) pra resolver os imports
// extensionless + tsconfig paths do worker-functions.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths').register();

const { DateTime } = require('luxon');
const {
  AdmissionCalendarService,
  computeFreeSlots,
  AR_ZONE,
} = require('../src/modules/matching/infrastructure/AdmissionCalendarService.ts');

const HOSTS = ['enlite@enlite.health', 'javier.bernal@enlite.health'];

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(
    'Imports OK. Para rodar contra dado real, defina GOOGLE_APPLICATION_CREDENTIALS ' +
      '(ex.: GOOGLE_APPLICATION_CREDENTIALS=.keys/enlite-prd-e7b9624315e8.json node scripts/admission-availability-proof.mjs)',
  );
  process.exit(0);
}

async function main() {
  const service = new AdmissionCalendarService();
  const now = new Date();

  // Janela de leitura de busy: de agora até +5 dias corridos (cobre 3 dias úteis).
  const fromISO = DateTime.fromJSDate(now, { zone: AR_ZONE }).toISO();
  const toISO = DateTime.fromJSDate(now, { zone: AR_ZONE }).plus({ days: 5 }).toISO();

  const busyIntervalsByHost = {};
  for (const host of HOSTS) {
    const intervals = await service.getBusyIntervals(host, fromISO, toISO);
    busyIntervalsByHost[host] = intervals;
    console.log(`\n[busy] ${host}: ${intervals.length} intervalos`);
    for (const iv of intervals) {
      const s = DateTime.fromJSDate(iv.start, { zone: AR_ZONE }).toFormat('ccc dd/MM HH:mm');
      const e = DateTime.fromJSDate(iv.end, { zone: AR_ZONE }).toFormat('HH:mm');
      console.log(`   ${s} → ${e}`);
    }
  }

  // Horizonte curto (3 dias úteis) pra prova.
  const slots = computeFreeSlots({
    busyIntervalsByHost,
    now,
    horizonBusinessDays: 3,
  });

  console.log('\n=== SLOTS LIVRES (45min, grade :00, 09-18 AR, próximos 3 dias úteis) ===');
  console.log(`Total: ${slots.length}\n`);
  for (const slot of slots) {
    const when = DateTime.fromISO(slot.startISO).setZone(AR_ZONE).toFormat('ccc dd/MM HH:mm');
    console.log(`  ${when}  →  livres: ${slot.hostEmails.join(', ')}`);
  }
}

main().catch((err) => {
  console.error('Falhou:', err);
  process.exit(1);
});
