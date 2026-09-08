import { AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms';

/**
 * Caixa de aviso âmbar do drawer de serviço contratado — a pendência que o operador precisa ver
 * no momento da carga, não na hora de ativar.
 *
 * Existem duas no mesmo formulário (paciente sem domicílio, 06/09; serviço sem horário, 07/09) e
 * elas têm de ser IDÊNTICAS: são a mesma classe de mensagem, e um âmbar diferente em cada uma
 * seria ruído. `role="alert"` para o leitor de tela anunciar sem o operador ir procurar.
 */
export function AvisoAmbar({ testId, children }: { testId: string; children: string }): JSX.Element {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <Text as="span" size="sm" color="inherit">{children}</Text>
    </div>
  );
}
