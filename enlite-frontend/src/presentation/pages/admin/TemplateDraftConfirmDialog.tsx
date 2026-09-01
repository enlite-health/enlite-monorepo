/**
 * A confirmação do envio (spec 010, F2 2.4).
 *
 * ⚠️ Existe por um motivo só: ENUMERAR o que se torna irreversível antes do
 * clique. A spec pede isso com todas as letras — "vê uma confirmação que enumera
 * o que se torna irreversível, e o botão de envio só habilita após confirmação
 * explícita". Um `window.confirm('tem certeza?')` cumpriria a forma e não a
 * substância: "tem certeza" não informa nada a quem não sabe o que vai acontecer.
 *
 * Componente separado também porque a página bateu no teto de 400 linhas — e o
 * teto existe justamente para forçar esse tipo de corte.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

/** Os três fatos irreversíveis, na ordem em que doem. */
const CONSEQUENCIAS = ['nome', 'edicao', 'prazo'] as const;

export interface TemplateDraftConfirmDialogProps {
  slug: string;
  enviando: boolean;
  onConfirmar: () => void;
  onCancelar: () => void;
}

export function TemplateDraftConfirmDialog({
  slug, enviando, onConfirmar, onCancelar,
}: TemplateDraftConfirmDialogProps): JSX.Element {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  /**
   * Rola até si ao aparecer.
   *
   * ⚠️ Não é polimento: a pessoa clica "Enviar" numa linha lá embaixo da lista, e
   * sem isto a confirmação nasce fora do campo de visão — ela clicaria, não
   * veria nada acontecer, e clicaria de novo. Visto no screenshot do e2e, não
   * deduzido. O `?.` existe porque jsdom não implementa `scrollIntoView`.
   */
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'center' });
  }, []);

  return (
    <div ref={ref} className="mb-6 rounded border-2 border-red-400 bg-red-50 p-4" data-testid="td-confirmar">
      <Heading level={3}>{t('admin.templateDrafts.confirmar.titulo', { slug })}</Heading>
      <ul className="my-3 list-disc pl-5" data-testid="td-confirmar-lista">
        {CONSEQUENCIAS.map((k) => (
          <li key={k}>
            <Text size="sm" color="inherit">{t(`admin.templateDrafts.confirmar.${k}`)}</Text>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button data-testid="td-confirmar-sim" isLoading={enviando} disabled={enviando} onClick={onConfirmar}>
          {t('admin.templateDrafts.confirmar.sim')}
        </Button>
        <Button variant="outline" data-testid="td-confirmar-nao" onClick={onCancelar}>
          {t('admin.templateDrafts.confirmar.nao')}
        </Button>
      </div>
    </div>
  );
}
