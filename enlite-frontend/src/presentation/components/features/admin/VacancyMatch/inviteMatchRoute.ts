/** A página "Invitar prestadores" já mostra o progresso (alerta F4 + "Enviando…"): o painel global não duplica nela. */
export const isInviteMatchRoute = (pathname: string): boolean => /^\/admin\/vacancies\/[^/]+\/match\/?$/.test(pathname);
