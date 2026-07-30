/**
 * Saúde do ENVIO REAL de WhatsApp de admissão — sem mandar nenhuma mensagem.
 *
 * Este é o outro lado da jornada. Lá, o paciente é sintético e o backend
 * PROPOSITALMENTE não envia (senão cobraria Twilio todo dia e poderia acertar um
 * número real). Aqui a gente responde "e o envio de verdade, está de pé?" olhando
 * o que aconteceu com PACIENTES REAIS nas últimas 24h, direto no Cloud Logging.
 *
 * Custo: zero. Nenhuma mensagem sai daqui.
 *
 * A regra de alerta é assimétrica de propósito:
 *   • `send_failed` presente  → FALHA. Alguém real não recebeu a confirmação.
 *   • `confirmation.sent` ausente → NÃO falha. Pode simplesmente não ter havido
 *     agendamento nas últimas 24h; um monitor que grita por ausência de tráfego
 *     vira ruído e o time para de ler o email. Fica registrado como evidência.
 */
import { test, expect } from '@playwright/test';
import { queryLogs, payloadString } from '../src/support/cloudLogging';

const JANELA_MIN = 24 * 60;

test('nenhuma confirmação de admissão FALHOU nas últimas 24h', async () => {
  const falhas = await queryLogs({
    message: 'admission.notifier.confirmation.send_failed',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description: `send_failed nas últimas 24h: ${falhas.length}`,
  });

  if (falhas.length > 0) {
    const detalhe = falhas
      .map((f) => `${f.timestamp} appt=${payloadString(f, 'appointmentId')} err=${payloadString(f, 'error')}`)
      .join(' | ');
    test.info().annotations.push({ type: 'falhas', description: detalhe });
  }

  expect(falhas.length, 'confirmação de admissão falhou para paciente REAL').toBe(0);
});

test('envios reais das últimas 24h (evidência, não gate)', async () => {
  const enviados = await queryLogs({
    message: 'admission.notifier.confirmation.sent',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description:
      enviados.length > 0
        ? `${enviados.length} confirmação(ões) enviada(s); último externalId=${payloadString(enviados[0] ?? null, 'externalId')}`
        : 'nenhum agendamento real nas últimas 24h (sem tráfego ≠ defeito)',
  });

  // Toda mensagem enviada precisa ter id externo da Twilio — sem isso não há
  // como rastrear a entrega depois.
  for (const e of enviados) {
    expect(
      payloadString(e, 'externalId'),
      'confirmação enviada sem externalId da Twilio — impossível rastrear',
    ).toBeTruthy();
  }
});

test('template de confirmação continua configurado', async () => {
  const semTemplate = await queryLogs({
    message: 'admission.notifier.confirmation.template_not_configured',
    withinMinutes: JANELA_MIN,
    limit: 5,
  });

  test.info().annotations.push({
    type: 'evidência',
    description: `template_not_configured nas últimas 24h: ${semTemplate.length}`,
  });

  // Este é silencioso em produção: o agendamento dá certo e a pessoa não recebe
  // nada. Só o log denuncia — por isso ele é gate.
  expect(
    semTemplate.length,
    'agendamento ocorreu sem template de WhatsApp configurado — paciente ficou sem confirmação',
  ).toBe(0);
});
