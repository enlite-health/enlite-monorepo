import { useEffect, useState } from 'react';

/**
 * `inView` vira `true` depois que o elemento entrou na viewport (uma vez, não volta atrás). 096 DD-8: o script do Google
 * Maps só carrega quando a seção aparece. Sem `IntersectionObserver` (jsdom, navegador antigo) vale `true`: o mapa nunca
 * fica sem carregar. `ref` é um callback ref: o nó pode montar DEPOIS do primeiro render (a seção troca de esqueleto
 * para mapa quando a rota responde), e o observador tem de pegar o nó quando ele aparece.
 */
export function useInView<T extends Element>(): { ref: (node: T | null) => void; inView: boolean } {
  const supported = typeof IntersectionObserver !== 'undefined';
  const [node, setNode] = useState<T | null>(null);
  const [inView, setInView] = useState(!supported);

  useEffect(() => {
    if (!supported || !node || inView) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [supported, node, inView]);

  return { ref: setNode, inView };
}
