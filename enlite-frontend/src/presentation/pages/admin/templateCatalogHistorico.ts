/**
 * A linha do tempo de uma mensagem — a peça que a Tela 4 do desenho acrescenta.
 *
 * Lógica pura, sem React, porque a pergunta que ela responde é sobre DADO e não
 * sobre pixel: "que eventos desta mensagem nós realmente sabemos, e em que
 * ordem". Testar isso através de um render seria testar a coisa errada.
 *
 * 🔒 ELA SÓ MOSTRA O QUE EXISTE, e isso não é limitação — é o desenho estando
 * certo sobre um caso que ele não desenhou. A maquete mostra três marcos
 * (criado → enviado → recusado) para uma mensagem que nasceu no nosso painel.
 * Mas 26 das 28 linhas de produção NÃO nasceram aqui: vieram do Console da
 * Twilio pelo sync, e para elas não existe "borrador creado" nem autor. Inventar
 * um marco para preencher a maquete seria a tela afirmar uma autoria que ninguém
 * registrou — exatamente o tipo de mentira que este catálogo existe para acabar.
 *
 * Por isso o retorno pode ter 1 evento, 3, ou nenhum, e a tela diz qual é o caso.
 */
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import type { TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';

/**
 * A cor do marco, e ela carrega significado.
 *
 * `bad` não é "erro do sistema": é a Meta tendo dito não, ou tendo desligado
 * algo que estava no ar. `now` é o único estado em que ainda há o que esperar.
 */
export type Marcador = 'done' | 'bad' | 'now';

export interface EventoLinhaDoTempo {
  /** Sufixo da chave de i18n: `admin.templateCatalog.timeline.<tipo>`. */
  tipo: 'criado' | 'enviado' | 'aprovado' | 'recusado' | 'pausado' | 'desligado' | 'aguardando';
  marcador: Marcador;
  /** ISO ou `null` quando o instante não foi registrado. A tela não inventa data. */
  quandoISO: string | null;
  /** `uid` de quem fez. `null` para o que veio da Meta — lá não há autor nosso. */
  quem: string | null;
}

/**
 * O veredito da Meta traduzido em marco.
 *
 * ⚠️ `PAUSED` e `DISABLED` têm evento PRÓPRIO e não caem em "recusado". São
 * coisas diferentes: recusada nunca esteve no ar; pausada ESTAVA e a Meta
 * desligou por retorno negativo de quem recebeu. Tratar as duas como a mesma
 * faria a tela sugerir "duplicar e corrigir o texto" para um problema que não é
 * de texto — é sobre o número.
 */
function vereditoDaMeta(status: string | null): Pick<EventoLinhaDoTempo, 'tipo' | 'marcador'> | null {
  switch (status) {
    case 'APPROVED': return { tipo: 'aprovado', marcador: 'done' };
    case 'REJECTED': return { tipo: 'recusado', marcador: 'bad' };
    case 'PAUSED': return { tipo: 'pausado', marcador: 'bad' };
    case 'DISABLED': case 'LIMIT_EXCEEDED': return { tipo: 'desligado', marcador: 'bad' };
    case 'PENDING': case 'IN_APPEAL': return { tipo: 'aguardando', marcador: 'now' };
    // `null` é "nunca verificado" — ausência de informação nossa, não um estado
    // da Meta. Não vira marco: a tela já diz "sin verificar" no cabeçalho, e um
    // ponto na linha do tempo sugeriria que algo aconteceu naquele instante.
    default: return null;
  }
}

/**
 * Monta a linha do tempo a partir do que temos.
 *
 * @param row      a linha do catálogo (o que a Meta respondeu)
 * @param rascunho o rascunho de mesmo slug, quando a mensagem nasceu no painel
 */
export function construirLinhaDoTempo(
  row: TemplateCatalogRow,
  rascunho: TemplateDraft | null,
): EventoLinhaDoTempo[] {
  const eventos: EventoLinhaDoTempo[] = [];

  if (rascunho) {
    eventos.push({ tipo: 'criado', marcador: 'done', quandoISO: rascunho.createdAt, quem: rascunho.createdBy });
    if (rascunho.submittedAt) {
      eventos.push({ tipo: 'enviado', marcador: 'done', quandoISO: rascunho.submittedAt, quem: rascunho.submittedBy });
    }
  }

  const veredito = vereditoDaMeta(row.metaStatus);
  if (veredito) {
    eventos.push({ ...veredito, quandoISO: row.metaCheckedAt, quem: null });
  }

  return eventos;
}

/**
 * Quanto tempo a Meta levou entre o envio e o veredito.
 *
 * A maquete mostra "19/05/2026 09:34 · 14 min después", e o "depois" é o que dá
 * escala: 14 minutos e três dias contam histórias diferentes sobre o mesmo
 * "rechazada".
 *
 * 🔒 A UNIDADE MUDA COM O TAMANHO, e isso não é polimento — foi um defeito que
 * eu escrevi e que só a foto pegou. A versão anterior devolvia sempre MINUTOS, e
 * na captura de uma mensagem enviada em maio e verificada em agosto a tela dizia
 * «149892 min después». O número estava certo e não significava nada: ninguém lê
 * três meses em minutos. Régua que só existe na unidade errada não informa.
 *
 * Devolve `null` quando falta uma das duas pontas — sem envio registrado não há
 * de quê contar, e um "0 min" nesse caso seria falso.
 */
export function demoraAteOVeredito(
  eventos: EventoLinhaDoTempo[],
): { valor: number; unidade: 'min' | 'h' | 'd' } | null {
  const enviado = eventos.find((e) => e.tipo === 'enviado')?.quandoISO;
  const veredito = eventos.find((e) => ['aprovado', 'recusado', 'pausado', 'desligado'].includes(e.tipo))?.quandoISO;
  if (!enviado || !veredito) return null;
  const ms = new Date(veredito).getTime() - new Date(enviado).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return { valor: min, unidade: 'min' };
  const h = Math.round(min / 60);
  if (h < 48) return { valor: h, unidade: 'h' };
  return { valor: Math.round(h / 24), unidade: 'd' };
}

/**
 * O link para o Content na Twilio — o "Ver el detalle en Twilio ↗" do desenho.
 *
 * 🔒 Devolve `null` sem `contentSid`, e o botão SOME em vez de ficar morto. Um
 * link que leva a uma página de erro é pior que link nenhum: quem clica conclui
 * que o sistema está quebrado, quando o certo é "esta mensagem nunca chegou à
 * Twilio" — que é informação, e já está dita no campo Content SID.
 */
export function urlNoTwilio(contentSid: string | null): string | null {
  if (!contentSid) return null;
  return `https://console.twilio.com/us1/develop/sms/content-template-builder/template/${contentSid}`;
}
