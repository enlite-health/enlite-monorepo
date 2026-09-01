/**
 * As verificações determinísticas do rascunho de mensagem (spec 010, F2 2.2).
 *
 * ⚠️ CORREÇÃO DE 01/09/2026 — O QUE ESTE COMENTÁRIO AFIRMAVA ERA FALSO.
 *
 * Ele dizia que o documento de boas práticas "NÃO existe no repositório" e que
 * as regras aqui eram deduzidas da documentação da Meta. O documento EXISTE: é
 * o artifact "Registro de Plantillas", que traz as 25 regras COM ID —
 * `META-01…06`, `UTIL-01…05`, `MKT-01…03`, `AR-01`, `AR-02`, `BR-02`,
 * `ENL-01…04`, `ENG-01…04`. Procurar só dentro de `specs/` e concluir "não
 * existe" foi medir o lugar errado e reportar ausência como fato.
 *
 * Fica registrado porque a afirmação também está no corpo do PR #271, e quem
 * ler aquele PR vai chegar aqui.
 *
 * ✅ IMPLEMENTADAS AQUI, cada uma com o ID que a governa:
 *   META-01  corpo até 1024                    → `muito_longo`
 *   META-02  no máximo 10 variáveis            → `variaveis_demais`
 *   META-04  não começa nem termina com var    → `placeholder_no_inicio/_no_fim`
 *   META-05  sem `#`, `$`, `%` na variável     → `variavel_com_simbolo`
 *   META-06  minúscula, dígito e underscore    → `formato`
 *   AR-01    cláusula de baja (es-AR)          → `sem_clausula_de_baja`
 *   MKT-02   caminho de saída (MARKETING)      → `sem_caminho_de_saida`
 *   ENG-02   só variável que sabemos preencher → `variavel_desconhecida`
 *
 * ❌ NÃO implementadas, e o motivo é medido, não preguiça:
 *   META-03  "sequenciais a partir de {{1}}" não se aplica: aqui a variável é
 *            NOMEADA, e o posicional é recusado (`placeholder_posicional`). A
 *            numeração só nasce em `paraTwilio`, já sequencial por construção.
 *   META-06  o teto de 512 do nome não entra: `slug` é `VARCHAR(120)` na
 *            migration 298 e `z.string().max(120)` no controller. Subir exige
 *            migration — está em LISTA, não aqui.
 *   MKT-01   "opt-in registrado antes do envio" NÃO é verificável no rascunho:
 *            não há destinatário. É regra do caminho de ENVIO (o portão de
 *            consentimento do `AdmissionReminderService`), não do compositor.
 *            Implementá-la aqui seria um `✓` que não verifica nada.
 *
 * 🔒 A REGRA MAIS IMPORTANTE DAQUI, e ela não é da Meta — é nossa:
 *
 * Placeholder é NOMEADO (`{{worker_name}}`), nunca posicional (`{{1}}`).
 *
 * O `StageTemplateEligibility` marca template com posicional como INELEGÍVEL
 * para mensagem por etapa: cada template daria um significado diferente ao
 * `{{1}}`, e não há como o sistema saber o que preencher. Um posicional aqui
 * produziria template APROVADO pela Meta e INUTILIZÁVEL pela plataforma — que é
 * o mesmo defeito de "aprovado e inenviável" que esta spec existe para não
 * repetir, só que na outra ponta.
 *
 * A conversão para o `{{1}}` que a Twilio quer acontece em `paraTwilio`, no
 * momento da submissão. É para isso que o campo `variables` dela serve.
 *
 * 🔒 Passar aqui NÃO é promessa de aprovação: é um filtro de erro óbvio, e a
 * tela não pode dizer que significa mais do que isso.
 */
import { SUPPORTED_PLACEHOLDERS } from '../application/StageTemplateEligibility';
import { OPT_OUT_EXACT, OPT_OUT_CONTAINS, normalizeForOptOut } from './optOutMatch';

/** Limite de corpo documentado pela Meta para template de WhatsApp. */
export const LIMITE_CORPO = 1024;

/** Categorias que a Meta aceita na submissão. */
export const CATEGORIAS = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** Os dois idiomas que a operação usa hoje (emenda do Gabriel, 31/08). */
export const IDIOMAS = ['es-AR', 'pt-BR'] as const;
export type Idioma = (typeof IDIOMAS)[number];

/**
 * O código de idioma como a TWILIO quer — que NÃO é o nosso.
 *
 * ⚠️ MEDIDO em 01/09/2026 contra a conta de produção, depois de a API recusar
 * `es-AR` com `92004 Invalid language code`. Os 28 Contents que existem lá usam:
 *   es_AR — 23 · es — 3 · pt_BR — 2
 * Ou seja: UNDERSCORE, não hífen. `es-AR` é o formato do nosso i18n (BCP 47) e
 * mandá-lo direto foi o defeito.
 *
 * 🔒 Por que isto merece uma função e um teste: nenhum teste unitário pega esta
 * classe de erro, porque todos batem no nosso próprio dublê. Só a API real
 * pegou — e ela só foi consultada porque alguém perguntou "como sabemos que
 * REALMENTE funciona?".
 */
export function idiomaTwilio(language: string): string {
  return language.replace('-', '_');
}

/** Prefixo de slug por idioma — derivado, nunca digitado. */
export const PREFIXO_POR_IDIOMA: Record<Idioma, string> = {
  'es-AR': 'ar_',
  'pt-BR': 'br_',
};

/**
 * As variáveis que o sistema sabe preencher.
 *
 * ⚠️ Importado de `StageTemplateEligibility`, NÃO redefinido: se as duas listas
 * divergissem, a tela aceitaria uma variável que o envio não sabe preencher, e
 * o erro só apareceria com a mensagem já aprovada e no ar.
 */
export const VARIAVEIS_SUPORTADAS: ReadonlySet<string> = SUPPORTED_PLACEHOLDERS;

export interface RascunhoEntrada {
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
}

/** Limite de variáveis distintas num template (META-02). */
export const LIMITE_VARIAVEIS = 10;

/**
 * Símbolos que a Meta recusa DENTRO do parâmetro (META-05).
 *
 * Ela usa `#`, `$` e `%` como marcadores próprios no conteúdo do template; um
 * deles dentro de `{{...}}` faz a submissão voltar como formato inválido.
 */
export const SIMBOLOS_PROIBIDOS_NA_VARIAVEL = /[#$%]/;

/**
 * O que um problema faz com o botão.
 *
 * `bloqueia` — a gravação e a submissão param. É defeito de plataforma: o
 *              template seria recusado pela Meta ou ficaria inenviável aqui.
 * `aviso`    — a tela mostra e a pessoa decide. Emenda do Gabriel em 01/09:
 *              nenhuma regra de conteúdo trava o botão; a decisão de mandar
 *              sem cláusula de baja é de quem escreve, não do validador.
 *
 * 🔒 POR QUE A SEVERIDADE PRECISOU EXISTIR: antes de hoje, todo `Problema`
 * devolvido virava 422, e a tela só via a lista quando a API RECUSAVA. Não
 * havia canal para "isto está faltando, e mesmo assim podés seguir" — ou
 * bloqueava, ou era invisível. Um aviso sem canal vira regra morta.
 */
export type Gravidade = 'bloqueia' | 'aviso';

/** Um problema encontrado. `campo` é o que a tela destaca; `regra` é o que ela explica. */
export interface Problema {
  campo: 'slug' | 'name' | 'body' | 'category' | 'language';
  regra: string;
  gravidade: Gravidade;
  /** Preenchido quando a regra fala de um token específico. */
  token?: string;
}

/** Só o que impede gravar ou submeter. */
export function bloqueios(ps: readonly Problema[]): Problema[] {
  return ps.filter(p => p.gravidade === 'bloqueia');
}

/** Só o que a tela mostra sem travar nada. */
export function avisos(ps: readonly Problema[]): Problema[] {
  return ps.filter(p => p.gravidade === 'aviso');
}

/** Todo `{{...}}` do texto, na ordem, com o conteúdo cru entre as chaves. */
export function tokensDe(body: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^}]*?)\s*\}\}/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(body);
  }
  return out;
}

/** Só os nomeados e suportados, sem repetição, na ordem de primeira aparição. */
export function variaveisDe(body: string): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const t of tokensDe(body)) {
    if (VARIAVEIS_SUPORTADAS.has(t) && !vistos.has(t)) {
      vistos.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Converte o texto NOSSO (nomeado) no par que a Twilio quer.
 *
 * `Hola {{worker_name}}, caso {{case_number}}`
 *   → body: `Hola {{1}}, caso {{2}}`
 *   → variaveis: ['worker_name', 'case_number']
 *
 * A repetição da mesma variável reusa o MESMO número — a Twilio numera valores,
 * não ocorrências, e dar dois números ao mesmo dado faria a segunda vir vazia.
 */
export function paraTwilio(body: string): { body: string; variaveis: string[] } {
  const variaveis = variaveisDe(body);
  const posicao = new Map(variaveis.map((v, i) => [v, i + 1]));
  const convertido = body.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (todo, nome: string) => {
    const p = posicao.get(nome);
    return p === undefined ? todo : `{{${p}}}`;
  });
  return { body: convertido, variaveis };
}

/**
 * Deriva o slug final a partir do que a pessoa digitou e do idioma escolhido.
 *
 * Idempotente de propósito: se já começa com o prefixo do idioma, não duplica.
 * Sem isso, salvar duas vezes produzia `ar_ar_convite`.
 */
export function slugComPrefixo(base: string, language: Idioma): string {
  const limpo = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const prefixo = PREFIXO_POR_IDIOMA[language];
  return limpo.startsWith(prefixo) ? limpo : `${prefixo}${limpo}`;
}

/**
 * As formas de MANDAR responder algo. Normalizadas (minúscula, sem acento).
 *
 * Sem o verbo, a palavra sozinha não é cláusula: um texto que diz "podés
 * cancelar tu entrevista" contém `cancelar`, e tratá-lo como saída ofereceria
 * um `✓` para uma mensagem que não dá saída nenhuma.
 */
const CONVITES_A_RESPONDER = [
  'responde', 'respondenos', 'responda', 'respondiendo', 'respondendo',
  'contesta', 'contestanos', 'escribi', 'escribinos', 'escreva', 'escrevendo',
  'envia', 'enviá', 'envie', 'manda', 'mandanos', 'mande', 'escribe',
];

/** Quanto texto pode haver entre o convite e a palavra. Uma frase, não um parágrafo. */
const ALCANCE_DA_CLAUSULA = 60;

/** O que o detector encontrou no corpo. */
export type Clausula =
  /** Convite + palavra que o inbound HONRA. É saída de verdade. */
  | { tipo: 'reconhecida'; termo: string }
  /** Convite, mas a palavra pedida não está no conjunto que o inbound honra. */
  | { tipo: 'nao_reconhecida' }
  /** Nem convite. */
  | { tipo: 'ausente' };

/**
 * A cláusula de baja do corpo — AR-01 (Decreto 1558/2001, art. 27) e MKT-02.
 *
 * 🔒 O QUE FAZ ESTA REGRA VALER ALGUMA COISA: ela não procura "alguma frase de
 * saída". Ela procura uma palavra que o `matchesOptOut` do inbound REALMENTE
 * reconhece — o mesmo conjunto, importado, nunca copiado.
 *
 * O caso `nao_reconhecida` é o que justifica a função existir. Uma mensagem que
 * diz «Respondé NO MÁS para no recibir más» passa em qualquer checagem que só
 * procure "tem cláusula?" — e a cuidadora que responder "NO MÁS" não vai ser
 * dada de baixa, porque esse termo não está no conjunto. A promessa de saída
 * que não funciona é PIOR que a ausência: a ausência é visível, essa não.
 */
export function clausulaDeBaja(body: string): Clausula {
  const t = normalizeForOptOut(body);

  let achouConvite = false;
  for (const convite of CONVITES_A_RESPONDER) {
    let i = t.indexOf(convite);
    while (i !== -1) {
      achouConvite = true;
      const janela = t.slice(i + convite.length, i + convite.length + ALCANCE_DA_CLAUSULA);
      const termo = termoHonradoEm(janela);
      if (termo !== null) return { tipo: 'reconhecida', termo };
      i = t.indexOf(convite, i + 1);
    }
  }
  return achouConvite ? { tipo: 'nao_reconhecida' } : { tipo: 'ausente' };
}

/** O primeiro termo de baixa presente na janela, ou `null`. */
function termoHonradoEm(janela: string): string | null {
  for (const frase of OPT_OUT_CONTAINS) {
    if (janela.includes(frase)) return frase;
  }
  // Os EXACT são termos que o inbound só honra como corpo INTEIRO — então aqui
  // valem como PALAVRA, com fronteira. Sem a fronteira, `sacar` casaria dentro
  // de "sacarte la duda" e o `✓` seria falso.
  for (const termo of OPT_OUT_EXACT) {
    const re = new RegExp(`(^|[^a-z0-9])${termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    if (re.test(janela)) return termo;
  }
  return null;
}

/**
 * Valida o rascunho. Devolve TODOS os problemas, não só o primeiro.
 *
 * Devolver um de cada vez faz a pessoa corrigir, salvar, descobrir o próximo, e
 * repetir — cada volta custa um round-trip e a paciência dela.
 */
export function validarRascunho(e: RascunhoEntrada): Problema[] {
  const p: Problema[] = [];
  const bloqueia = (campo: Problema['campo'], regra: string, token?: string): void => {
    p.push(token === undefined ? { campo, regra, gravidade: 'bloqueia' } : { campo, regra, gravidade: 'bloqueia', token });
  };
  const avisa = (campo: Problema['campo'], regra: string): void => {
    p.push({ campo, regra, gravidade: 'aviso' });
  };

  // --- identidade
  if (e.name.trim().length === 0) {
    bloqueia('name', 'obrigatorio');
  }
  if (e.slug.trim().length === 0) {
    bloqueia('slug', 'obrigatorio');
  } else if (!/^[a-z0-9_]+$/.test(e.slug)) {
    // META-06: a Meta aceita só minúscula, dígito e underscore no nome.
    bloqueia('slug', 'formato');
  }

  if (!(CATEGORIAS as readonly string[]).includes(e.category)) {
    bloqueia('category', 'invalida');
  }
  if (!(IDIOMAS as readonly string[]).includes(e.language)) {
    bloqueia('language', 'invalido');
  }

  // --- corpo
  const body = e.body;
  if (body.trim().length === 0) {
    bloqueia('body', 'obrigatorio');
    return p; // as regras seguintes falam do texto; sem texto, não há o que dizer.
  }
  if (body.length > LIMITE_CORPO) {
    bloqueia('body', 'muito_longo'); // META-01
  }

  const tokens = tokensDe(body);
  const distintos = new Set(tokens);
  // META-02. Conta os DISTINTOS: a Twilio numera valores, não ocorrências, e
  // `paraTwilio` reusa o mesmo número na repetição — contar ocorrências
  // recusaria um texto que a Meta aceita.
  if (distintos.size > LIMITE_VARIAVEIS) {
    bloqueia('body', 'variaveis_demais');
  }

  for (const t of distintos) {
    if (/^\d+$/.test(t)) {
      // Posicional: aprovaria na Meta e ficaria inelegível aqui.
      bloqueia('body', 'placeholder_posicional', t);
    } else if (SIMBOLOS_PROIBIDOS_NA_VARIAVEL.test(t)) {
      // META-05. Vem ANTES de `variavel_desconhecida` de propósito: um token com
      // `#` também é desconhecido, e mandar a pessoa "usar uma das disponíveis"
      // esconde que o problema é o símbolo — ela trocaria o nome e erraria de novo.
      bloqueia('body', 'variavel_com_simbolo', t);
    } else if (!VARIAVEIS_SUPORTADAS.has(t)) {
      // ENG-02: variável que o envio não sabe preencher chegaria vazia à cuidadora.
      bloqueia('body', 'variavel_desconhecida', t);
    }
  }

  if (tokens.length > 0) {
    const semEspaco = body.trim();
    // META-04: começar ou terminar com variável é recusa documentada da Meta —
    // sem texto em volta ela não consegue avaliar o conteúdo.
    if (/^\{\{[^}]*\}\}/.test(semEspaco)) {
      bloqueia('body', 'placeholder_no_inicio');
    }
    if (/\{\{[^}]*\}\}$/.test(semEspaco)) {
      bloqueia('body', 'placeholder_no_fim');
    }
    // Duas coladas: idem — a Meta recusa por não haver texto entre elas.
    if (/\}\}\s*\{\{/.test(body)) {
      bloqueia('body', 'placeholders_adjacentes');
    }
  }

  // --- caminho de saída (AR-01 e MKT-02) — AVISO, nunca bloqueio.
  //
  // Decisão do Gabriel em 01/09: o validador não trava o botão por conteúdo.
  // Mandar sem cláusula é escolha de quem escreve — mas ela precisa ser uma
  // escolha VISTA, e não um esquecimento silencioso.
  //
  // Um aviso só, mesmo quando as duas regras se aplicam: a pessoa tem UM texto
  // para acrescentar, e dois alertas sobre a mesma linha faltando é ruído.
  const precisaAR = e.language === 'es-AR';        // AR-01 · Decreto 1558/2001, art. 27
  const precisaMKT = e.category === 'MARKETING';   // MKT-02 · diretriz da Meta
  if (precisaAR || precisaMKT) {
    const c = clausulaDeBaja(body);
    if (c.tipo === 'nao_reconhecida') {
      // Pior que ausente, e por isso tem chave própria: o texto PROMETE uma
      // saída, e a palavra que ele manda responder não está no conjunto que o
      // inbound honra. Quem responder não é dado de baixa, e ninguém fica sabendo.
      avisa('body', 'clausula_de_baja_nao_reconhecida');
    } else if (c.tipo === 'ausente') {
      avisa('body', precisaAR ? 'sem_clausula_de_baja' : 'sem_caminho_de_saida');
    }
  }

  return p;
}
