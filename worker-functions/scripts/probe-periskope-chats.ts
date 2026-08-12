/**
 * probe-periskope-chats.ts — SONDA DE CONTRATO, SOMENTE LEITURA.
 *
 * Por que existe: o e2e `patient-chat-ids.e2e.test.ts` prova o NOSSO lado contra
 * um stub HTTP local (determinístico, roda em CI). Stub nenhum prova que o
 * fornecedor não mudou o contrato. Esta sonda fecha esse buraco: bate na API
 * REAL do Periskope e verifica que `GET /chats` continua respondendo o envelope
 * e os campos que o `PeriskopeChatReadService` lê.
 *
 * 🚨 NUNCA ESCREVE. O único endpoint tocado é `GET /chats`. O serviço usado
 * (`PeriskopeChatReadService`) não expõe caminho de escrita — não há como este
 * script enviar mensagem, nota ou ticket.
 *
 * 🔒 NUNCA IMPRIME PII. Nome de grupo carrega nome de paciente e chat_id carrega
 * telefone (Ley 25.326). A saída é só contagem, nome de campo e formato.
 *
 * Uso:
 *   PERISKOPE_API_KEY=$(gcloud secrets versions access latest \
 *     --secret=periskope-api-key --project=enlite-prd) \
 *   PERISKOPE_PHONE=<numero conectado> \
 *   npx ts-node -r tsconfig-paths/register scripts/probe-periskope-chats.ts
 *
 * Exit 0 = contrato válido. Exit 1 = contrato quebrado (ou sem credencial).
 */

import { createPeriskopeHttpClient, PeriskopeChatReadService } from '@modules/notification';

const GROUP_SUFFIX = '@g.us';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function main(): Promise<void> {
  const http = createPeriskopeHttpClient();
  if (!http) {
    console.error('SEM CREDENCIAL: defina PERISKOPE_API_KEY e PERISKOPE_PHONE.');
    process.exit(1);
  }

  // ── 1. O endpoint responde e o ENVELOPE tem a forma que a gente assume ─────
  const res = await http.get('/chats', { params: { chat_type: 'group', limit: 50 } });

  check('HTTP GET /chats responde 200', res.status === 200, `status=${res.status}`);

  const body = res.data as Record<string, unknown>;
  const envelopeKeys = Object.keys(body ?? {}).sort();
  check(
    'envelope tem as chaves esperadas',
    ['chats', 'count', 'from', 'to'].every(k => envelopeKeys.includes(k)),
    `chaves=${JSON.stringify(envelopeKeys)}`,
  );

  const chats = Array.isArray(body?.chats) ? (body.chats as Array<Record<string, unknown>>) : [];
  check('chats é array não vazio', chats.length > 0, `n=${chats.length}`);

  // ── 2. Os CAMPOS que o PeriskopeChatReadService lê existem e têm o tipo ────
  const fieldsWeRead = ['chat_id', 'chat_name', 'member_count'] as const;
  for (const field of fieldsWeRead) {
    const present = chats.filter(c => field in c).length;
    check(
      `campo '${field}' presente em todos os chats`,
      present === chats.length,
      `${present}/${chats.length}`,
    );
  }

  const chatIdAllStrings = chats.every(c => typeof c.chat_id === 'string');
  check('chat_id é string em todos', chatIdAllStrings, `n=${chats.length}`);

  const chatNameTypesOk = chats.every(c => c.chat_name === null || typeof c.chat_name === 'string');
  check('chat_name é string ou null em todos', chatNameTypesOk, 'sem valores impressos (PII)');

  const memberCountTypesOk = chats.every(
    c => c.member_count === null || c.member_count === undefined || typeof c.member_count === 'number',
  );
  const withMemberCount = chats.filter(c => typeof c.member_count === 'number').length;
  check(
    'member_count é number, null ou ausente',
    memberCountTypesOk,
    `${withMemberCount}/${chats.length} com número`,
  );

  // ── 3. O filtro chat_type=group DE FATO devolve só grupo (@g.us) ───────────
  const groups = chats.filter(c => String(c.chat_id).endsWith(GROUP_SUFFIX));
  check(
    `filtro chat_type=group devolve 100% ${GROUP_SUFFIX}`,
    groups.length === chats.length,
    `${groups.length}/${chats.length}`,
  );

  // O formato do id de grupo é o que o CHECK da migration 260 aceita.
  const migrationPattern = /^[0-9]+(-[0-9]+)?@g\.us$/;
  const matchMigration = chats.filter(c => migrationPattern.test(String(c.chat_id))).length;
  check(
    'todo chat_id casa com o CHECK da migration 260',
    matchMigration === chats.length,
    `${matchMigration}/${chats.length} (padrão ^[0-9]+(-[0-9]+)?@g\\.us$)`,
  );

  // ── 4. O NOSSO serviço mapeia o payload real sem perder nada ──────────────
  const service = new PeriskopeChatReadService();
  const mapped = await service.listGroupChats();
  check('PeriskopeChatReadService.listGroupChats() não devolve null', mapped !== null, `null=${mapped === null}`);
  if (mapped) {
    check(
      'todo item mapeado tem chatId de grupo',
      mapped.every(m => m.chatId.endsWith(GROUP_SUFFIX)),
      `n=${mapped.length}`,
    );
    check(
      'mapeamento preserva chatName (string|null) e memberCount (number|null)',
      mapped.every(
        m =>
          (m.chatName === null || typeof m.chatName === 'string') &&
          (m.memberCount === null || typeof m.memberCount === 'number'),
      ),
      `${mapped.filter(m => m.chatName !== null).length}/${mapped.length} com nome`,
    );
    check(
      'nenhum chat 1-1 (@c.us) atravessa o serviço',
      mapped.every(m => !m.chatId.endsWith('@c.us')),
      `n=${mapped.length}`,
    );
  }

  // ── Relatório ─────────────────────────────────────────────────────────────
  console.log('SONDA DE CONTRATO — Periskope GET /chats (SOMENTE LEITURA)');
  console.log(`data: ${new Date().toISOString()}`);
  console.log('-'.repeat(78));
  for (const c of checks) {
    console.log(`${c.ok ? 'OK  ' : 'FALHA'} | ${c.name.padEnd(52)} | ${c.detail}`);
  }
  console.log('-'.repeat(78));

  const failed = checks.filter(c => !c.ok);
  console.log(`${checks.length - failed.length}/${checks.length} verificações passaram`);
  console.log('nenhum nome de grupo, chat_id ou telefone foi impresso (PII, Ley 25.326)');

  if (failed.length > 0) {
    console.error(`CONTRATO QUEBRADO em ${failed.length} verificação(ões).`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('SONDA FALHOU:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
