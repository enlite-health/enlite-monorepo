/**
 * As verificações determinísticas do rascunho de mensagem (spec 010, F2 2.2).
 *
 * ⚠️ HONESTIDADE SOBRE A FONTE: o `plan.md` fala em "as 14 regras marcadas como
 * 'código' no documento de boas práticas". Esse documento NÃO existe no
 * repositório — procurado em 31/08/2026 em `specs/010-catalogo-plantillas-whatsapp/`
 * e não encontrado. Em vez de inventar 14 regras e atribuí-las a uma spec que
 * não as contém, aqui estão as que se sustentam na documentação da Meta e no
 * comportamento MEDIDO deste sistema, cada uma com o motivo.
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

/** Um problema encontrado. `campo` é o que a tela destaca; `regra` é o que ela explica. */
export interface Problema {
  campo: 'slug' | 'name' | 'body' | 'category' | 'language';
  regra: string;
  /** Preenchido quando a regra fala de um token específico. */
  token?: string;
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
 * Valida o rascunho. Devolve TODOS os problemas, não só o primeiro.
 *
 * Devolver um de cada vez faz a pessoa corrigir, salvar, descobrir o próximo, e
 * repetir — cada volta custa um round-trip e a paciência dela.
 */
export function validarRascunho(e: RascunhoEntrada): Problema[] {
  const p: Problema[] = [];

  // --- identidade
  if (e.name.trim().length === 0) {
    p.push({ campo: 'name', regra: 'obrigatorio' });
  }
  if (e.slug.trim().length === 0) {
    p.push({ campo: 'slug', regra: 'obrigatorio' });
  } else if (!/^[a-z0-9_]+$/.test(e.slug)) {
    // A Meta aceita só minúscula, dígito e underscore no nome do template.
    p.push({ campo: 'slug', regra: 'formato' });
  }

  if (!(CATEGORIAS as readonly string[]).includes(e.category)) {
    p.push({ campo: 'category', regra: 'invalida' });
  }
  if (!(IDIOMAS as readonly string[]).includes(e.language)) {
    p.push({ campo: 'language', regra: 'invalido' });
  }

  // --- corpo
  const body = e.body;
  if (body.trim().length === 0) {
    p.push({ campo: 'body', regra: 'obrigatorio' });
    return p; // as regras seguintes falam do texto; sem texto, não há o que dizer.
  }
  if (body.length > LIMITE_CORPO) {
    p.push({ campo: 'body', regra: 'muito_longo' });
  }

  const tokens = tokensDe(body);
  for (const t of new Set(tokens)) {
    if (/^\d+$/.test(t)) {
      // Posicional: aprovaria na Meta e ficaria inelegível aqui.
      p.push({ campo: 'body', regra: 'placeholder_posicional', token: t });
    } else if (!VARIAVEIS_SUPORTADAS.has(t)) {
      // Variável que o envio não sabe preencher chegaria vazia à cuidadora.
      p.push({ campo: 'body', regra: 'variavel_desconhecida', token: t });
    }
  }

  if (tokens.length > 0) {
    const semEspaco = body.trim();
    // Começar ou terminar com variável é recusa documentada da Meta: sem texto
    // em volta ela não consegue avaliar o conteúdo.
    if (/^\{\{[^}]*\}\}/.test(semEspaco)) {
      p.push({ campo: 'body', regra: 'placeholder_no_inicio' });
    }
    if (/\{\{[^}]*\}\}$/.test(semEspaco)) {
      p.push({ campo: 'body', regra: 'placeholder_no_fim' });
    }
    // Duas coladas: idem — a Meta recusa por não haver texto entre elas.
    if (/\}\}\s*\{\{/.test(body)) {
      p.push({ campo: 'body', regra: 'placeholders_adjacentes' });
    }
  }

  return p;
}
