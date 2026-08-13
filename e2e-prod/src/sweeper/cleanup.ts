/**
 * cleanup.ts — sweeper idempotente de resíduo sintético em PRODUÇÃO.
 *
 * O `package.json` chamava este arquivo (`npm run sweep`) desde o começo e ele
 * **não existia**. Agora existe, e com um motivo concreto: a jornada do paciente
 * cria registro real em produção. Se um run morrer entre "criou" e "limpou", fica
 * um paciente sintético na lista da equipe de admissão e dentro do funil.
 *
 * O afterAll da jornada já tenta limpar. Este sweeper é a rede de baixo: roda
 * ANTES da suíte (ou sob demanda) e purga o que sobrou de runs anteriores.
 *
 * Como acha o resíduo: `is_test = true`. É a mesma marca que a jornada põe logo
 * depois de criar o lead, e a mesma que o endpoint de purge exige. Não há
 * heurística por nome/email — marca explícita ou nada.
 *
 * Idempotente: rodar duas vezes seguidas não faz mal (a segunda não acha nada).
 * Nunca lança por resíduo não-limpo: reporta e sai 0, porque falhar o sweeper
 * mascararia o resultado dos testes que vêm depois.
 */
import { newAdminApiContext } from '../support/adminApi';

interface PatientRow {
  id: string;
  isTest?: boolean;
  createdAt?: string;
}

interface PurgeResult {
  appointmentsCancelled: number;
  calendarEventsDeleted: number;
  calendarEventsFailed: number;
  vacanciesDeleted: number;
}

/** Idade mínima para considerar órfão — não pisa num run em andamento. */
const MIN_IDADE_MIN = Number(process.env.SWEEP_MIN_AGE_MINUTES ?? 30);

async function main(): Promise<void> {
  const api = await newAdminApiContext();
  try {
    // O endpoint de listagem não filtra por is_test; pegamos uma janela recente
    // e filtramos aqui. O volume é baixo (um sintético por dia, no máximo).
    const res = await api.get('/api/admin/patients?limit=200');
    if (res.status() !== 200) {
      console.error(`[sweeper] não consegui listar pacientes: HTTP ${res.status()}`);
      return;
    }

    const { data } = (await res.json()) as { data: PatientRow[] };
    const limite = Date.now() - MIN_IDADE_MIN * 60_000;

    const orfaos = data.filter((p) => {
      if (!p.isTest) return false;
      if (!p.createdAt) return true;
      return new Date(p.createdAt).getTime() < limite;
    });

    if (orfaos.length === 0) {
      console.log('[sweeper] nenhum paciente sintético órfão. Nada a fazer.');
      return;
    }

    console.log(`[sweeper] ${orfaos.length} paciente(s) sintético(s) órfão(s) — purgando...`);
    for (const p of orfaos) {
      const del = await api.delete(`/api/admin/patients/${p.id}`);
      if (del.status() === 200) {
        const { data: r } = (await del.json()) as { data: PurgeResult };
        console.log(
          `[sweeper] ✅ ${p.id} — entrevistas=${r.appointmentsCancelled} ` +
            `calendar=${r.calendarEventsDeleted} (falhas=${r.calendarEventsFailed}) vagas=${r.vacanciesDeleted}`,
        );
        if (r.calendarEventsFailed > 0) {
          console.warn(`[sweeper] ⚠️  ${p.id} deixou evento órfão no Google Calendar`);
        }
      } else {
        // 409 aqui significaria que a listagem devolveu isTest errado — reporta
        // alto, mas não derruba: o sweeper nunca deve impedir a suíte de rodar.
        console.warn(`[sweeper] ⚠️  ${p.id} não purgado: HTTP ${del.status()} ${await del.text()}`);
      }
    }
  } finally {
    await api.dispose();
  }
}

main().catch((err) => {
  console.error('[sweeper] erro inesperado:', err instanceof Error ? err.message : err);
  // Sai 0 de propósito — ver docblock.
});
