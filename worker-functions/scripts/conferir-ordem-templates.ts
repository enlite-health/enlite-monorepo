/**
 * conferir-ordem-templates.ts — SOMENTE LEITURA. Não escreve no banco, não
 * envia mensagem, não altera nada na Twilio.
 *
 * O que ele responde: "o texto que a Meta aprovou é o mesmo que está no nosso
 * `body`, e as variáveis estão na MESMA ORDEM?"
 *
 * Por que existe: o envio monta as `contentVariables` posicionais mapeando os
 * placeholders NOMEADOS do nosso `body` pela ordem de aparição
 * (`TwilioMessagingService.mapToContentVariables`). A Twilio, do lado dela, tem
 * `{{1}}`, `{{2}}`… O guard `SLOT_MISMATCH` compara QUANTIDADE — se os nomes
 * estiverem em ordem trocada, a aridade bate, tudo fica verde, e a cuidadora
 * recebe os valores nos lugares errados ("Hola CASO 1042, tu candidatura al caso
 * María González"). Nenhum teste vê isso, porque as duas pontas da comparação
 * saem do NOSSO banco. Só comparando com a Content API dá para saber.
 *
 * Como decide: substitui, dos dois lados, cada placeholder pelo seu ÍNDICE de
 * aparição (`«1»`, `«2»`…) e compara os textos normalizados. Igual = o texto e a
 * ordem batem. Diferente = imprime os dois para leitura humana; não tenta
 * adivinhar.
 *
 * Uso (nunca no CI — depende de rede):
 *   DATABASE_URL=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... \
 *     npx ts-node -r tsconfig-paths/register scripts/conferir-ordem-templates.ts
 *   ... --slug qualified_reprogram_confirm    # confere só um
 */
import { Pool } from 'pg';
import { extractPlaceholders } from '../src/modules/notification/application/StageTemplateEligibility';
import { extractContentBody, type ContentTypes } from '../src/modules/notification/infrastructure/twilioContentBody';

const CONTENT_API = 'https://content.twilio.com/v1/Content';

interface Row { slug: string; body: string | null; category: string | null; content_sid: string }

/** A regra do ENVIO, importada — não copiada: é a ordem dela que precisa bater. */
const placeholders = (body: string): string[] => extractPlaceholders(body);

/** Troca cada placeholder pelo índice de aparição: as duas pontas ficam comparáveis. */
function skeleton(body: string): string {
  const order = placeholders(body);
  return body
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_f, k: string) => `«${order.indexOf(k) + 1}»`)
    .replace(/\s+/g, ' ')
    .trim();
}

/** A MESMA extração que o sync e a tela usam. */
const bodyOfContent = (payload: unknown): string | null =>
  extractContentBody((payload as { types?: ContentTypes } | null)?.types);

async function main(): Promise<void> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, DATABASE_URL: url } = process.env;
  if (!sid || !token || !url) throw new Error('faltam DATABASE_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN');
  const only = process.argv.includes('--slug') ? process.argv[process.argv.indexOf('--slug') + 1] : null;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  const db = new Pool({ connectionString: url });
  const { rows } = await db.query<Row>(
    `SELECT slug, body, category, content_sid FROM message_templates
     WHERE is_active = true AND content_sid IS NOT NULL ${only ? 'AND slug = $1' : ''}
     ORDER BY slug`,
    only ? [only] : [],
  );

  let iguais = 0; const divergentes: string[] = []; const semTexto: string[] = [];

  for (const r of rows) {
    const res = await fetch(`${CONTENT_API}/${r.content_sid}`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) { semTexto.push(`${r.slug} (HTTP ${res.status})`); continue; }
    const aprovado = bodyOfContent(await res.json());
    if (!aprovado) { semTexto.push(`${r.slug} (Content sem body)`); continue; }

    const nosso = skeleton(r.body ?? '');
    const deles = skeleton(aprovado);
    const nomes = placeholders(r.body ?? '');

    if (nosso === deles) {
      iguais++;
      console.log(`✅ ${r.slug.padEnd(34)} ${nomes.length} var  [${nomes.join(', ')}]`);
    } else {
      divergentes.push(r.slug);
      console.log(`\n❌ ${r.slug}  (${r.category ?? 'sem categoria'})`);
      console.log(`   nosso body  : ${nosso.slice(0, 160)}`);
      console.log(`   Meta aprovou: ${deles.slice(0, 160)}`);
      console.log(`   ordem nossa : ${nomes.join(' → ') || '(nenhuma variável)'}\n`);
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log(`iguais: ${iguais} · divergentes: ${divergentes.length} · sem texto: ${semTexto.length}`);
  if (divergentes.length) console.log(`divergentes: ${divergentes.join(', ')}`);
  if (semTexto.length) console.log(`sem texto: ${semTexto.join(', ')}`);
  console.log('Divergência NÃO é bug automático — é leitura humana obrigatória antes de usar o template numa etapa.');
  await db.end();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
