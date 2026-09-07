import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

interface PlaceholderCardProps {
  /** Chave i18n do título do card (mesma chave que o card usava antes de virar placeholder). */
  titleKey: string;
  testId?: string;
}

/**
 * Spec 014 US-D2 (decisão do Gabriel 03/09, item 9): card inteiramente vazio — sem dado, sem
 * endpoint, sem drawer — diz "ainda não existe" UMA vez, sem rótulo `—` fantasma, botão `disabled`
 * sem ação nem busca decorativa.
 *
 * 06/09: o que era uma CAIXA vira uma LINHA. Cada um destes ocupava `min-h-[160px]` + `py-10`, e
 * são três na aba "Datos clínicos" — 480px de altura dizendo que não há o que ver, na primeira
 * tela que a operadora abre. Medido: eram 33% da ficha inteira (694 de 2086px, junto com o vazio
 * do cartão da direita).
 *
 * 🔒 O container CONTINUA existindo, um por card: a D286 dá célula de permissão a cada um, e a aba
 * some quando o ator não tem nenhuma. O que encolheu foi a altura — nada de fundir os três numa
 * linha só, que seria mudar a fronteira de permissão em vez do interior dela.
 */
export function PlaceholderCard({ titleKey, testId }: PlaceholderCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className="bg-white rounded-card border border-dashed border-gray-700 px-6 py-3.5 flex flex-wrap items-baseline gap-x-2 gap-y-1"
      data-testid={testId}
    >
      <Text as="span" size="sm" weight="medium" color="primary">
        {t(titleKey)}
      </Text>
      {/* O separador é decoração: fica fora do texto para não entrar no nome acessível nem
          grudar na string traduzida (`getByText('Em breve')` deixaria de casar). */}
      <Text as="span" size="xs" color="muted" aria-hidden="true">·</Text>
      <Text as="span" size="xs" color="muted">
        {t('admin.patients.detail.comingSoon')}
      </Text>
    </div>
  );
}
