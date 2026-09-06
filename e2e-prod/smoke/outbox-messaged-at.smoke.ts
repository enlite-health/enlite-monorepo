/**
 * Saúde do carimbo `messaged_at` no convite AUTOMÁTICO (D200.9) — sem mandar nada.
 *
 * O convite automático de vaga sai pelo `messaging_outbox` → `OutboxProcessor`.
 * Desde a D200.9, ao marcar a mensagem como enviada o processador também carimba
 * `worker_job_applications.messaged_at` — é isso que faz o card do Kanban mostrar
 * "Último envío" (e, pela D200.1, travar o "Reenviar" dentro da janela de 24 h).
 * Sem o carimbo o card diz "Sin envíos" para quem JÁ recebeu a mensagem.
 *
 * Em produção não dá para provocar esse fluxo com dado sintético: o gate `is_test`
 * bloqueia o envio de WhatsApp para entidades de teste (de propósito). Então a
 * prova aqui é observar o TRÁFEGO REAL das últimas 24 h no Cloud Logging, igual ao
 * `admission-whatsapp-health.smoke.ts`. Custo: zero. Nenhuma mensagem sai daqui.
 *
 * Regra de alerta assimétrica (mesma da casa):
 *   • `outbox.messaged_at.failed` presente → FALHA (o envio saiu e o card ficou errado).
 *   • `outbox.messaged_at.updated` ausente → NÃO falha (pode não ter havido convite
 *     automático em 24 h; ausência de tráfego ≠ defeito). Fica como evidência no email.
 */
import { test, expect } from '@playwright/test';
import { queryLogs, payloadString } from '../src/support/cloudLogging';

const JANELA_MIN = 24 * 60;

test('nenhum carimbo de messaged_at FALHOU após convite automático nas últimas 24h', async () => {
  const falhas = await queryLogs({
    message: 'outbox.messaged_at.failed',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description: `outbox.messaged_at.failed nas últimas 24h: ${falhas.length}`,
  });
  if (falhas.length > 0) {
    const detalhe = falhas
      .map((f) => `${f.timestamp} outbox=${payloadString(f, 'outboxId')} err=${payloadString(f, 'error')}`)
      .join(' | ');
    test.info().annotations.push({ type: 'falhas', description: detalhe });
  }

  expect(falhas.length, 'convite automático enviado SEM carimbar messaged_at — o card vai dizer "Sin envíos"').toBe(0);
});

test('carimbos de messaged_at das últimas 24h (evidência, não gate)', async () => {
  const carimbos = await queryLogs({
    message: 'outbox.messaged_at.updated',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description:
      carimbos.length > 0
        ? `${carimbos.length} candidatura(s) carimbada(s) pelo convite automático; último outbox=${payloadString(carimbos[0] ?? null, 'outboxId')}`
        : 'nenhum convite automático nas últimas 24h (sem tráfego ≠ defeito)',
  });

  // Todo carimbo precisa apontar a candidatura (worker × vaga) — sem isso não há
  // como conferir o card correspondente.
  for (const c of carimbos) {
    expect(payloadString(c, 'workerId'), 'carimbo sem workerId').toBeTruthy();
    expect(payloadString(c, 'jobPostingId'), 'carimbo sem jobPostingId').toBeTruthy();
  }
});
