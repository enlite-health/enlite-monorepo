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
 *   • `admission.confirmation_failed` presente  → FALHA. Alguém real não recebeu a confirmação.
 *   • `admission.confirmation_sent` ausente → NÃO falha. Pode simplesmente não ter havido
 *     agendamento nas últimas 24h; um monitor que grita por ausência de tráfego
 *     vira ruído e o time para de ler o email. Fica registrado como evidência.
 */
import { test, expect } from '@playwright/test';
import { queryLogs, payloadString } from '../src/support/cloudLogging';

const JANELA_MIN = 24 * 60;

/**
 * CONTROLE POSITIVO (R-22). Os testes que afirmam "zero ocorrências" só valem se a MESMA
 * consulta, na MESMA janela, enxerga o serviço. Em 10/10 os nomes antigos do prefixo do notifier já
 * não existiam e o teste ficava verde por não medir nada.
 *
 * Por que NÃO `admission.confirmation_sent`: medido em prd, 0 ocorrências em 30 dias (não há
 * confirmação real a enviar todo dia), então exigi-lo deixaria o monitor eternamente vermelho.
 * `admission.post_call.run_done` é emitido pelo cron de admissão (~40/dia, medido) com o mesmo
 * logger/serviço dos eventos de envio — prova que o nome do campo, o serviço e a janela estão
 * certos, independentemente de ter havido tráfego de pacientes.
 */
async function exigirQueAConsultaEnxerga(): Promise<void> {
  const vistos = await queryLogs({
    message: 'admission.post_call.run_done',
    withinMinutes: JANELA_MIN,
    limit: 1,
  });
  expect(
    vistos.length,
    'não medi: nenhum log de admissão (admission.post_call.run_done) na janela — a consulta não enxerga o serviço, "zero" não prova nada',
  ).toBeGreaterThanOrEqual(1);
}

test('nenhuma confirmação de admissão FALHOU nas últimas 24h', async () => {
  await exigirQueAConsultaEnxerga();
  const falhas = await queryLogs({
    message: 'admission.confirmation_failed',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description: `send_failed nas últimas 24h: ${falhas.length}`,
  });

  if (falhas.length > 0) {
    const detalhe = falhas
      .map((f) => `${f.timestamp} appt=${payloadString(f, 'appointmentId')} reason=${payloadString(f, 'reason')}`)
      .join(' | ');
    test.info().annotations.push({ type: 'falhas', description: detalhe });
  }

  expect(falhas.length, 'confirmação de admissão falhou para paciente REAL').toBe(0);
});

test('envios reais das últimas 24h (evidência, não gate)', async () => {
  const enviados = await queryLogs({
    message: 'admission.confirmation_sent',
    withinMinutes: JANELA_MIN,
    limit: 20,
  });

  test.info().annotations.push({
    type: 'evidência',
    description:
      enviados.length > 0
        ? `${enviados.length} confirmação(ões) enviada(s); último twilioSid=${payloadString(enviados[0] ?? null, 'twilioSid')}`
        : 'nenhum agendamento real nas últimas 24h (sem tráfego ≠ defeito)',
  });

  // Toda mensagem enviada precisa ter id externo da Twilio — sem isso não há
  // como rastrear a entrega depois.
  for (const e of enviados) {
    expect(
      payloadString(e, 'twilioSid'),
      'confirmação enviada sem twilioSid da Twilio — impossível rastrear',
    ).toBeTruthy();
  }
});

test('template de confirmação continua configurado', async () => {
  await exigirQueAConsultaEnxerga();
  const semTemplate = await queryLogs({
    message: 'admission.skipped_no_template',
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
