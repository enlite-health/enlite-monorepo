/**
 * InlineLoadingState — spinner + texto para a CARGA INICIAL de um painel/lista (spec 022, ajustes
 * de UI B5: achado "painel fica branco até a resposta chegar"). Componente compartilhado —
 * `ConversationPanel`, `ThreadView` e `NotificationPanel` usavam o MESMO vazio (nada renderizado
 * enquanto `status/isLoading` não resolve); em vez de 3 divs quase idênticas, um só componente.
 *
 * `role="status"` + `aria-live="polite"`: leitor de tela anuncia o texto quando o estado aparece,
 * sem interromper o que já estava sendo lido (`polite`, nunca `assertive` — não é um erro).
 *
 * 🔒 NUNCA para POLL/refresh depois da 1ª carga boa — quem usa isto decide a condição
 * (`status === 'loading'` só na carga inicial, nunca dentro do poll de 5s/refresh) para não
 * piscar a cada tick. Este componente só RENDERIZA quando mandado; não tem lógica de quando.
 */
import { Text } from '@presentation/components/atoms/Text';

export interface InlineLoadingStateProps {
  label: string;
  'data-testid'?: string;
}

export function InlineLoadingState({ label, 'data-testid': testId }: InlineLoadingStateProps): JSX.Element {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className="flex flex-col items-center justify-center gap-2 p-8">
      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" aria-hidden="true" />
      <Text size="xs" color="secondary">{label}</Text>
    </div>
  );
}
