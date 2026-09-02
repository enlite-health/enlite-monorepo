/**
 * "Así lo recibe la cuidadora" — o balão de WhatsApp da Tela 2.
 *
 * 🔒 POR QUE UM BALÃO E NÃO UMA CAIXA DE TEXTO. O que a tela substituiu era um
 * `<div>` cinza com o texto dentro, e ele respondia a pergunta errada: mostrava
 * o que estava escrito, não como aquilo CHEGA. Quebra de linha, tamanho do
 * parágrafo e onde o nome cai só ficam evidentes na forma em que a pessoa vai
 * ler — e quem escreve a mensagem nunca a viu do lado de lá.
 *
 * ⚠️ OS VALORES SÃO DE EXEMPLO E ISSO É DITO NA TELA. Nunca usamos uma
 * cuidadora real na pré-visualização: seria PII entrando numa tela de
 * configuração, e a regra do projeto é que dado de pessoa não passeia por onde
 * não precisa. `previewDe` substitui por `[nombre]`/`[nº de caso]`, e o token
 * que ele não conhece fica CRU de propósito — a pessoa precisa ver que aquilo
 * não vai ser preenchido.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

/** Os valores que o balão mostra no lugar das variáveis. */
const EXEMPLOS: Record<string, string> = {
  worker_name: 'María González',
  name: 'María González',
  case_number: '1042',
};

/** Só para a foto: a hora do balão não pode mudar a cada render. */
const HORA = '14:32';

export function TemplateComposerPreview({ corpo }: { corpo: string }): JSX.Element {
  const { t } = useTranslation();

  /*
   * Os trechos: texto comum e valor de exemplo, separados, para o exemplo poder
   * vir grifado. Sem o grifo, quem lê não distingue o que é fixo do que muda a
   * cada envio — e é justamente essa distinção que a pré-visualização vende.
   */
  const partes: { texto: string; exemplo: boolean }[] = [];
  let resto = corpo;
  const re = /\{\{\s*([^}]*?)\s*\}\}/g;
  let m: RegExpExecArray | null;
  let ultimo = 0;
  while ((m = re.exec(corpo)) !== null) {
    if (m.index > ultimo) partes.push({ texto: corpo.slice(ultimo, m.index), exemplo: false });
    const valor = EXEMPLOS[m[1]];
    // Token desconhecido aparece CRU — a tela não inventa um valor para ele.
    partes.push({ texto: valor ?? m[0], exemplo: valor !== undefined });
    ultimo = m.index + m[0].length;
  }
  if (ultimo < corpo.length) partes.push({ texto: corpo.slice(ultimo), exemplo: false });
  resto = corpo;

  return (
    <div>
      <Text size="xs" color="secondary" className="mb-2 block">
        {t('admin.templateDrafts.asiLoRecibe')}
      </Text>
      <div className="rounded-2xl bg-[#E9E0D8] px-3.5 pb-4 pt-4" data-testid="td-preview">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-white">
            <Text as="span" size="xs" weight="semibold" color="inherit">E</Text>
          </span>
          <Text as="span" size="xs" color="inherit" className="text-[#5B5346]">
            EnLite Health · WhatsApp Business
          </Text>
        </div>
        {/* 13px e entrelinha 1,55 — os números do `.bubble` da maquete. */}
        <div className="rounded-b-xl rounded-tr-xl bg-white px-3 pb-2 pt-2.5 text-[13px] leading-[1.55] shadow-sm">
          {resto.trim().length === 0 ? (
            <Text size="sm" color="secondary">
              <span data-testid="td-preview-vazio">{t('admin.templateDrafts.previewVazio')}</span>
            </Text>
          ) : (
            <Text size="xs" color="inherit" className="whitespace-pre-wrap text-[13px] leading-[1.55] text-[#111B21]">
              <span data-testid="td-preview-texto">
                {partes.map((p, i) => (p.exemplo
                  ? <mark key={i} className="rounded-sm bg-[#FFF3C4] px-0.5 text-[#111B21]">{p.texto}</mark>
                  : <span key={i}>{p.texto}</span>))}
              </span>
            </Text>
          )}
          <Text size="xs" color="secondary" className="mt-1 block text-right text-[#8696A0]">{HORA}</Text>
        </div>
      </div>
      <Text size="xs" color="secondary" className="mt-2 block">
        {t('admin.templateDrafts.datosDeEjemplo')}
      </Text>
    </div>
  );
}
