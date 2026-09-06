/**
 * verificar-twilio-content-write.ts — a ÚNICA prova de que o formato está certo.
 *
 * ⚠️ POR QUE ESTE SCRIPT EXISTE:
 *
 * Nada neste repositório jamais fez POST para a API de Content da Twilio.
 * Medido em 31/08/2026: todo uso existente é GET (`fetchAllContents`,
 * `fetchWhatsAppApproval`, `TwilioContentBodyProvider`). O `TwilioContentWriter`
 * é a primeira escrita, e o formato do payload foi escrito de conhecimento — não
 * de medição, não de precedente no código, não de resposta real da Twilio.
 *
 * Consequência dura: se a Twilio esperar outro formato, TODOS os testes
 * unitários continuam verdes, porque todos batem no nosso próprio dublê. Nenhum
 * teste que eu escreva pode detectar isso. Só a API real pode.
 *
 * 🔒 O QUE ESTE SCRIPT FAZ, E O QUE ELE NÃO FAZ:
 *
 *   FAZ    — cria um Content DESCARTÁVEL na Twilio e lê a resposta.
 *            Criar Content é REVERSÍVEL: dá para apagar, e o script apaga.
 *   FAZ    — apaga o que criou, sempre, inclusive se a verificação falhar.
 *   NÃO FAZ— submeter à Meta. Submeter é IRREVERSÍVEL (queima o nome na WABA
 *            para sempre) e por isso não pode acontecer por um script de
 *            verificação. Esse passo exige decisão humana, uma vez, e sabendo.
 *   NÃO FAZ— mandar mensagem para ninguém. Content é definição de template; não
 *            há destinatário envolvido em nenhum momento.
 *
 * COMO RODAR:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
 *     npx ts-node -r dotenv/config scripts/verificar-twilio-content-write.ts
 *
 *   Sem `--apply` ele só IMPRIME o payload que mandaria e sai. O padrão é não
 *   tocar em nada: um script de verificação que escreve por default é uma
 *   armadilha esperando o próximo desavisado.
 */
import { idiomaTwilio, paraTwilio } from '../src/modules/notification/domain/templateDraftRules';

const TWILIO_BASE = 'https://content.twilio.com';

/**
 * Nome descartável e reconhecível. O prefixo `zz_` o joga para o fim de qualquer
 * listagem, e a data deixa claro que é lixo de verificação se algo sobreviver.
 */
const NOME = `zz_verificacao_formato_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const CORPO_NOSSO = 'Hola {{worker_name}}, esta es una verificacion tecnica del caso {{case_number}}. Ignorar.';

const APLICAR = process.argv.includes('--apply');

function auth(): string {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    console.error('Faltam TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN.');
    process.exit(1);
  }
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function main(): Promise<void> {
  const { body, variaveis } = paraTwilio(CORPO_NOSSO);
  const variables: Record<string, string> = {};
  variaveis.forEach((n, i) => { variables[String(i + 1)] = n; });

  const payload = {
    friendly_name: NOME,
    language: idiomaTwilio('es-AR'),
    variables,
    types: { 'twilio/text': { body } },
  };

  console.log('=== O payload que o TwilioContentWriter monta ===');
  console.log(JSON.stringify(payload, null, 2));
  console.log();

  if (!APLICAR) {
    console.log('DRY-RUN. Nada foi enviado. Use --apply para verificar contra a Twilio de verdade.');
    console.log('⚠️ Com --apply, um Content DESCARTÁVEL é criado e APAGADO em seguida.');
    console.log('   Nenhuma submissão à Meta acontece — isso é irreversível e não é feito por script.');
    return;
  }

  const header = auth();
  let sid: string | null = null;

  try {
    console.log('=== POST /v1/Content ===');
    const res = await fetch(`${TWILIO_BASE}/v1/Content`, {
      method: 'POST',
      headers: { Authorization: header, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const texto = await res.text();
    console.log(`HTTP ${res.status} ${res.statusText}`);
    console.log(texto.slice(0, 1500));

    if (!res.ok) {
      console.log();
      // ⚠️ Distinguir credencial de FORMATO. A 1ª versão deste script dizia
      // "FORMATO REJEITADO" para qualquer não-2xx, e num 403 de credencial de
      // teste isso apontava para o lugar errado — mandaria alguém "consertar"
      // um payload que estava certo. Régua que confunde duas causas é pior que
      // régua nenhuma.
      let codigo: number | null = null;
      try { codigo = (JSON.parse(texto) as { code?: number }).code ?? null; } catch { /* corpo não-JSON */ }

      if (res.status === 401 || res.status === 403 || codigo === 20008) {
        console.log('⚠️ INCONCLUSIVO — a recusa é de CREDENCIAL, não de formato.');
        console.log(`   code ${codigo ?? '(sem code)'} · ${res.status}. O payload não chegou a ser avaliado.`);
        console.log('   Credencial de TESTE da Twilio não acessa a API de Content (erro 20008 documentado).');
        console.log('   Para verificar o formato é preciso a credencial de produção.');
      } else {
        console.log('❌ FORMATO REJEITADO pela Twilio — é exatamente isto que nenhum teste unitário pega.');
        console.log('   Corrija `TwilioContentWriter.criarContent` conforme a mensagem acima.');
      }
      process.exitCode = 1;
      return;
    }

    const json = JSON.parse(texto) as { sid?: string; variables?: unknown; types?: unknown };
    sid = json.sid ?? null;

    console.log();
    console.log('✅ FORMATO ACEITO.');
    console.log(`   sid devolvido: ${sid ?? '(NENHUM — o writer falharia alto aqui, e está certo)'}`);
    console.log(`   variables como a Twilio guardou: ${JSON.stringify(json.variables)}`);
    console.log('   ⚠️ Isto prova o passo 2.3 (criar Content) e SÓ ele.');
    console.log('   O passo 2.4 (submeter à Meta) continua NÃO verificado — é irreversível.');
  } finally {
    if (sid) {
      console.log();
      console.log(`=== Limpando: DELETE /v1/Content/${sid} ===`);
      const del = await fetch(`${TWILIO_BASE}/v1/Content/${sid}`, {
        method: 'DELETE', headers: { Authorization: header },
      });
      console.log(`HTTP ${del.status} — ${del.ok ? 'apagado' : '⚠️ NÃO apagado, apague à mão'}`);
    }
  }
}

main().catch((err) => {
  console.error('Falhou:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
