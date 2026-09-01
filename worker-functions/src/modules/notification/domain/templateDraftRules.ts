/**
 * As verificações determinísticas do rascunho de mensagem (spec 010, F2 passo 2.2).
 *
 * ⚠️ HONESTIDADE SOBRE A FONTE: o `plan.md` fala em "as 14 regras marcadas como
 * 'código' no documento de boas práticas". Esse documento NÃO existe no
 * repositório — procurado em 31/08 em `specs/010-catalogo-plantillas-whatsapp/`
 * e não encontrado. Em vez de inventar 14 regras e atribuí-las a uma spec que
 * não as contém, aqui estão as que se sustentam na documentação da própria Meta
 * sobre templates, cada uma com o motivo. Quando o documento aparecer, o que
 * faltar entra aqui e o teste cresce junto.
 *
 * 🔒 Por que determinístico e não "a Meta que diga": porque a recusa da Meta
 * chega horas depois e queima o nome do template. O que dá para reprovar antes
 * de submeter, reprova antes — e o que NÃO dá, não fingimos saber. Esta lista é
 * um filtro de erro óbvio, nunca uma promessa de aprovação: passar aqui não
 * significa que a Meta aceita, e a tela não pode dizer que significa.
 */

/** Limite de corpo documentado pela Meta para template de WhatsApp. */
export const LIMITE_CORPO = 1024;

/** Categorias que a Meta aceita na submissão. */
export const CATEGORIAS = ['MARKETING', 'UTILITY', 'AUTHENTICATION'] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** Os dois idiomas que a operação usa hoje (emenda do Gabriel, 31/08). */
export const IDIOMAS = ['es-AR', 'pt-BR'] as const;
export type Idioma = (typeof IDIOMAS)[number];

/** Prefixo de slug por idioma — derivado, nunca digitado. */
export const PREFIXO_POR_IDIOMA: Record<Idioma, string> = {
  'es-AR': 'ar_',
  'pt-BR': 'br_',
};

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
}

/**
 * Os placeholders na ordem em que aparecem no texto.
 *
 * Exportada porque a tela precisa contá-los para a pré-visualização, e contar
 * duas vezes com dois regex diferentes é como as duas contagens divergem.
 */
export function placeholdersDe(body: string): number[] {
  const out: number[] = [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    out.push(Number(m[1]));
    m = re.exec(body);
  }
  return out;
}

/**
 * Deriva o slug final a partir do que a pessoa digitou e do idioma escolhido.
 *
 * Idempotente de propósito: se o texto já começa com o prefixo do idioma, não
 * duplica. Sem isso, salvar duas vezes produzia `ar_ar_convite`.
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
 * Devolver um de cada vez faz a pessoa corrigir, salvar, descobrir o próximo,
 * e repetir — cada volta custa um round-trip e a paciência dela.
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

  const ph = placeholdersDe(body);
  if (ph.length > 0) {
    // Numeração: a Meta exige {{1}}, {{2}}, … sem buraco e começando em 1.
    const ordenados = [...new Set(ph)].sort((a, b) => a - b);
    const esperado = ordenados.length > 0 && ordenados[0] === 1
      && ordenados.every((n, i) => n === i + 1);
    if (!esperado) {
      p.push({ campo: 'body', regra: 'placeholder_numeracao' });
    }

    // Começar ou terminar com placeholder é recusa documentada da Meta: sem
    // texto em volta ela não consegue avaliar o conteúdo.
    const semEspaco = body.trim();
    if (/^\{\{\s*\d+\s*\}\}/.test(semEspaco)) {
      p.push({ campo: 'body', regra: 'placeholder_no_inicio' });
    }
    if (/\{\{\s*\d+\s*\}\}$/.test(semEspaco)) {
      p.push({ campo: 'body', regra: 'placeholder_no_fim' });
    }

    // Dois placeholders colados: idem — a Meta recusa por não haver texto entre eles.
    if (/\}\}\s*\{\{/.test(body)) {
      p.push({ campo: 'body', regra: 'placeholders_adjacentes' });
    }
  }

  return p;
}
