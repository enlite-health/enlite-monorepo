/**
 * A coluna da esquerda do compositor (Tela 2): tipo, nome, idiomas e o texto.
 *
 * 🔒 A PERGUNTA MUDOU, e é a mudança central desta tela. Antes ela pedia
 * `category` num `<select>` com `UTILITY` / `MARKETING` / `AUTHENTICATION` —
 * vocabulário da Meta, exigido de quem não trabalha na Meta. Agora ela pergunta
 * o que a pessoa sabe responder ("é um aviso do processo?") e DERIVA a
 * categoria. O desenho é literal: "ninguém precisa saber o que é UTILITY".
 *
 * 🔒 E A VARIÁVEL ENTRA POR BOTÃO, NÃO DIGITADA. Um template aprovado rejeita
 * variável vazia — a Twilio devolve "Content Variables parameter is invalid" e a
 * mensagem inteira não sai. Só existem as variáveis que o sistema sabe preencher
 * no instante em que a tarjeta se move. Deixar digitar `{{...}}` livremente é
 * oferecer um jeito de escrever uma mensagem que a Meta aprova e que nunca vai
 * conseguir sair. Pelo botão, o conjunto é fechado por construção.
 */
import { useRef, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Input } from '@presentation/components/atoms/Input';
import { VARIAVEIS_AJUDA, LIMITE_CORPO } from './templateDraftsView';
import { TemplateComposerEditor, type EditorHandle } from './TemplateComposerEditor';
import { ES, IDIOMAS, TIPOS, parDeSlugs, type Idioma, type TipoDeMensagem } from './templateComposerView';

export interface ComposerFormProps {
  tipo: TipoDeMensagem;
  base: string;
  idiomas: readonly Idioma[];
  abaAtiva: Idioma;
  textos: Record<Idioma, string>;
  /** Edição de um rascunho já salvo: o idioma fica travado no dele. */
  travadoNoIdioma: Idioma | null;
  onTipo: (t: TipoDeMensagem) => void;
  onBase: (b: string) => void;
  onIdiomas: (i: Idioma[]) => void;
  onAba: (i: Idioma) => void;
  onTexto: (i: Idioma, texto: string) => void;
}

export function TemplateComposerForm({
  tipo, base, idiomas, abaAtiva, textos, travadoNoIdioma,
  onTipo, onBase, onIdiomas, onAba, onTexto,
}: ComposerFormProps): JSX.Element {
  const { t } = useTranslation();
  const areaRef = useRef<EditorHandle>(null);
  const par = parDeSlugs(base);
  const corpo = textos[abaAtiva] ?? '';
  const restante = LIMITE_CORPO - corpo.length;

  /**
   * Insere a variável ONDE O CURSOR ESTÁ, não no fim.
   *
   * ⚠️ Não é polimento: quem clica no botão está no meio de uma frase — "¡Hola
   * ▮! Te damos…" — e receber `{{worker_name}}` colado no fim do texto obriga a
   * recortar e colar de volta. O botão viraria um caminho mais longo do que
   * digitar, que é o que ele existe para evitar.
   */
  const inserir = (nome: string): void => inserirTexto(`{{${nome}}}`);

  /**
   * Insere QUALQUER texto na posição do cursor.
   *
   * Serve tanto à variável quanto à cláusula de baja — que não é variável, e
   * por isso não pode passar por um caminho que embrulha em `{{...}}`.
   */
  const inserirTexto = (token: string): void => {
    const el = areaRef.current;
    // Sem o editor montado (só acontece em teste de unidade sem DOM), acrescenta
    // no fim — o comportamento degrada, mas o texto nunca se perde.
    if (!el) { onTexto(abaAtiva, corpo + token); return; }
    el.inserir(token);
  };

  const alternarIdioma = (i: Idioma): void => {
    const tem = idiomas.includes(i);
    /*
     * 🔒 Não deixa desmarcar o último: uma mensagem sem idioma nenhum não é um
     * estado que o backend aceite, e a tela ficaria com abas para lugar nenhum.
     * Silencioso de propósito — o clique simplesmente não faz nada, em vez de
     * abrir um erro sobre algo que a pessoa não tentou fazer.
     */
    if (tem && idiomas.length === 1) return;
    const novo = tem ? idiomas.filter((x) => x !== i) : [...idiomas, i];
    onIdiomas(novo as Idioma[]);
    if (tem && abaAtiva === i) onAba(novo[0] as Idioma);
  };

  return (
    <div className="lg:pr-7">
      {/* ── que tipo de mensagem é ─────────────────────────────────────────── */}
      <div className="mb-5">
        <Label htmlFor="td-tipo" size="compact" className="block">{t('admin.templateDrafts.tipo.pergunta')}</Label>
        {/* 🔒 `flex-auto` (base AUTO), não `basis-0`. Com base 0 os três cartões
            ficavam da MESMA largura, e o desenho os deixa acompanhar o próprio
            texto (198/170/181px). `min-w-[140px]` só impede que um deles fique
            estreito demais — com a escala certa não sobra motivo para quebrar. */}
        <div className="mt-1.5 flex flex-wrap gap-[7px]" id="td-tipo" data-testid="td-tipos">
          {TIPOS.map((op) => (
            <button
              key={op.chave}
              type="button"
              data-testid={`td-tipo-${op.chave}`}
              aria-pressed={tipo === op.chave}
              onClick={() => onTipo(op.chave)}
              className={`min-w-[140px] flex-auto rounded-input border px-[13px] py-[9px] text-left text-[12.5px] leading-[1.35] ${
                tipo === op.chave
                  ? 'border-primary bg-primary text-white shadow-md'
                  : 'border-gray-600 bg-white text-primary'
              }`}
            >
              {/* 🔒 A ESCALA VAI NOS FILHOS, e não só no botão. O `<Text>` traz
                  a escala dele (12px/1,5) e ela vencia a do botão — a linha de
                  apoio saía a 12px/18px onde o desenho pede 10,5px/14,2px, e o
                  cartão inteiro crescia 3px de altura por conta disso. Sem peso
                  no título: na maquete os dois textos têm o mesmo, e o que
                  separa um do outro é tamanho e opacidade. */}
              <Text as="span" size="xs" color="inherit" className="text-[12.5px] !leading-[1.35]">
                {t(`admin.templateDrafts.tipo.${op.chave}.titulo`)}
              </Text>
              <Text as="span" size="xs" color="inherit" className="mt-0.5 block text-[10.5px] !leading-[1.35] opacity-[0.72]">
                {t(`admin.templateDrafts.tipo.${op.chave}.detalhe`)}
              </Text>
            </button>
          ))}
        </div>
        <Text size="2xs" color="secondary" className="mt-[5px] block">
          {t('admin.templateDrafts.tipo.ajuda')}
        </Text>
      </div>

      {/* ── o nome, uma vez só; o prefixo é nosso ──────────────────────────── */}
      <div className="mb-5">
        <Label htmlFor="td-base" size="compact" required className="block">{t('admin.templateDrafts.campo.nombre')}</Label>
        {/* 🔒 `inputSize="dense"` — o tamanho `default` do atom é 20px de texto
            em 60px de altura, desenhado para formulário de uma coluna com muito
            respiro. Aqui há quatro campos e uma coluna de pré-visualização ao
            lado: no `default` o campo competia com o próprio conteúdo, e o
            Gabriel bateu nisso em 01/09.
            ⚠️ `!text-[12px]` com `!` DE PROPÓSITO. O desenho usa 13px no campo
            comum e 12px no campo mono (`.inp.mono`), e o `dense` do atom já
            emite `text-[13px]`. Duas classes de mesma propriedade no mesmo
            elemento se resolvem pela ordem em que o Tailwind as EMITE, não pela
            ordem em que eu as escrevo — sem o `!`, o 13px ganhava em silêncio.
            Medido, não suposto. */}
        <Input
          id="td-base" data-testid="td-input-slug" value={base}
          inputSize="dense" className="mt-1.5 font-mono !text-[12px]"
          onChange={(e) => onBase(e.target.value)}
        />
        {/* As duas versões nascendo à vista. É a convenção que os templates
            argentinos já seguem — agora aplicada sozinha em vez de lembrada.
            🔒 A ESCALA É DECLARADA AQUI, item a item. Nada nestas linhas herda:
            a `div` da linha não tinha tamanho de fonte e caía no 16px/24px do
            body, o que sozinho engordava a linha de 30px para 38px e o selo
            `ar_` de 18px para 26px. Foi o que o Gabriel viu em 01/09. */}
        {par[ES] && (
          <div className="mt-2 flex flex-col gap-1.5" data-testid="td-par-slugs">
            {IDIOMAS.map((i) => (
              <div
                key={i}
                data-testid={`td-par-slug-${i}`}
                data-slug={par[i]}
                className="flex items-center gap-[9px] rounded-lg bg-[#F7F5FB] px-[11px] py-1.5 text-[11.5px] leading-[1.5] text-primary"
              >
                <span className="rounded-[5px] bg-primary px-1.5 py-px text-[10.5px] leading-[1.5] text-white">
                  <Text as="span" size="xs" color="inherit" className="font-mono text-[10.5px] leading-[1.5]">
                    {i === ES ? 'ar_' : 'br_'}
                  </Text>
                </span>
                {/* 🔒 O SELO JÁ É O PREFIXO — aqui vai só a base. Repetindo o
                    slug inteiro a linha lia "ar_ ar_bienvenida_contratacion", e
                    o selo deixava de significar alguma coisa. O slug completo
                    continua afirmável pelo teste em `data-slug` da linha. */}
                <Text as="span" size="xs" color="primary" className="font-mono text-[11.5px] leading-[1.5]">
                  <span data-testid={`td-slug-${i}`}>{base}</span>
                </Text>
                {/* Nome curto: o desenho escreve "· español", não "· Español
                    (Argentina)". A forma longa continua onde ela decide algo —
                    o seletor de idiomas, as abas, a modal e a Tela 4. */}
                <Text as="span" size="xs" color="secondary" className="font-mono text-[11.5px] leading-[1.5]">
                  · {t(`admin.templateDrafts.idiomaCorto.${i}`)}
                </Text>
              </div>
            ))}
          </div>
        )}
        <Text size="2xs" color="secondary" className="mt-[5px] block">
          {t('admin.templateDrafts.campo.nombreAjuda')}
        </Text>
      </div>

      {/* ── idiomas ────────────────────────────────────────────────────────── */}
      <div className="mb-5">
        <Label htmlFor="td-idiomas" size="compact" className="block">{t('admin.templateDrafts.campo.idiomas')}</Label>
        <div className="mt-1 flex flex-wrap gap-2" id="td-idiomas" data-testid="td-idiomas">
          {IDIOMAS.map((i) => {
            const sel = idiomas.includes(i);
            const travado = travadoNoIdioma !== null && travadoNoIdioma !== i;
            return (
              <button
                key={i}
                type="button"
                data-testid={`td-idioma-${i}`}
                aria-pressed={sel}
                disabled={travado}
                onClick={() => alternarIdioma(i)}
                className={`inline-flex items-center gap-2 rounded-input border px-3 py-[9px] text-[12.5px] leading-[1.5] text-primary ${
                  sel ? 'border-primary bg-[#F4F1FB]' : 'border-gray-600 bg-white'
                } ${travado ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border-[1.5px] ${
                  sel ? 'border-primary bg-primary text-white' : 'border-gray-600 bg-white'
                }`}>
                  {sel && <Text as="span" size="xs" color="inherit">✓</Text>}
                </span>
                <Text as="span" size="xs" color="primary">
                  {i === ES ? '🇦🇷' : '🇧🇷'} {t(`admin.templateDrafts.idioma.${i}`)}
                </Text>
              </button>
            );
          })}
        </div>
        <Text size="2xs" color="secondary" className="mt-1.5 block">
          {t(travadoNoIdioma ? 'admin.templateDrafts.campo.idiomaTravado' : 'admin.templateDrafts.campo.idiomasAjuda')}
        </Text>
      </div>

      {/* ── o texto, uma aba por idioma ────────────────────────────────────── */}
      <div>
        <Label id="td-body-rotulo" htmlFor="td-body" size="compact" required className="block">{t('admin.templateDrafts.campo.body')}</Label>
        <div className="mt-1 flex gap-0.5 border-b border-gray-300" role="tablist" data-testid="td-abas">
          {idiomas.map((i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={abaAtiva === i}
              data-testid={`td-aba-${i}`}
              onClick={() => onAba(i)}
              className={`-mb-px inline-flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3.5 py-[7px] text-[12.5px] font-medium leading-[1.5] ${
                abaAtiva === i ? 'border-gray-300 bg-white text-primary' : 'border-transparent text-gray-800'
              }`}
            >
              <Text as="span" size="xs" weight={abaAtiva === i ? 'medium' : undefined} color="inherit">
                {i === ES ? '🇦🇷' : '🇧🇷'} {t(`admin.templateDrafts.idioma.${i}`)}
              </Text>
              {/* O ponto âmbar diz qual falta, sem travar nada — o desenho deixa
                  enviar só um idioma agora e o outro depois. */}
              {(textos[i] ?? '').trim().length === 0 && (
                <span data-testid={`td-aba-falta-${i}`} aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-wait" />
              )}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 rounded-t-input border border-b-0 border-gray-600 bg-[#F7F5FB] px-2 py-1.5">
          <Text as="span" size="xs" color="secondary" className="mr-0.5">
            {t('admin.templateDrafts.inserir')}
          </Text>
          {VARIAVEIS_AJUDA.map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`td-inserir-${v}`}
              onClick={() => inserir(v)}
              className="h-[22px] shrink-0 rounded-pill border border-[#DCD3EE] bg-white px-2.5 py-[3px] text-[11px] leading-[normal] text-[#5A1FAE]"
            >
              <Text as="span" size="xs" color="inherit">{t(`admin.templateDrafts.variavel.${v}`, v)}</Text>
            </button>
          ))}

          {/* 🔒 SEPARADO DAS VARIÁVEIS, como no desenho, porque NÃO é uma
              variável: é um bloco de texto. Misturá-lo na mesma fileira sugere
              que ele vira `{{...}}`, e não vira. */}
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[#DCD3EE]" />
          <button
            type="button"
            data-testid="td-inserir-clausula"
            onClick={() => inserirTexto(t('admin.templateDrafts.clausulaDeBaja'))}
            className="h-[22px] shrink-0 rounded-pill border border-gray-300 bg-white px-2.5 py-[3px] text-[11px] leading-[normal] text-gray-800"
          >
            <Text as="span" size="xs" color="inherit">{t('admin.templateDrafts.inserirClausula')}</Text>
          </button>
        </div>
        <TemplateComposerEditor
          id="td-body" data-testid="td-input-body" ref={areaRef} aria-labelledby="td-body-rotulo"
          valor={corpo}
          variaveis={VARIAVEIS_AJUDA}
          onChange={(texto) => onTexto(abaAtiva, texto)}
        />
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <Text size="xs" color="secondary">
            {idiomas.filter((i) => (textos[i] ?? '').trim().length === 0).length > 0 && (
              <span data-testid="td-falta-idioma" className="text-[#7A5200]">
                {t('admin.templateDrafts.faltaOutroIdioma')}
                {/* 🔒 A AÇÃO JUNTO DO AVISO, como no desenho. Sem ela, "falta o
                    texto no outro idioma" é uma cobrança sem saída: a pessoa
                    teria de selecionar, copiar, trocar de aba e colar. Copiar o
                    original para traduzir por cima é o gesto real de quem
                    traduz. */}
                {corpo.trim().length > 0 && (
                  <>
                    {' — '}
                    <button
                      type="button"
                      data-testid="td-copiar-para-traduzir"
                      onClick={() => {
                        const outro = idiomas.find((i) => i !== abaAtiva && (textos[i] ?? '').trim().length === 0);
                        if (outro) { onTexto(outro, corpo); onAba(outro); }
                      }}
                      className="underline"
                    >
                      {t('admin.templateDrafts.copiarParaTraduzir')}
                    </button>
                  </>
                )}
              </span>
            )}
          </Text>
          <Text size="xs" color={restante < 0 ? 'inherit' : 'secondary'} className={restante < 0 ? 'text-red-700' : ''}>
            {/* O desenho conta o que JÁ FOI escrito ("218 / 1024"), não o que
                sobra. É a leitura que responde "cabe?" de relance. */}
            <span data-testid="td-restante">{corpo.length} / {LIMITE_CORPO}</span>
          </Text>
        </div>
      </div>
    </div>
  );
}
