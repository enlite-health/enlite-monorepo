import { useEffect, useRef, useState } from 'react';

/**
 * `true` depois que o elemento entrou na viewport (uma vez, não volta atrás). 096 DD-8: o script do Google Maps só carrega
 * quando a seção aparece. Sem `IntersectionObserver` (jsdom, navegador antigo) vale `true`: o mapa nunca fica sem carregar.
 */
export function useInView<T extends Element>(): { ref: React.RefObject<T>; inView: boolean } {
  const ref = useRef<T>(null);
  const supported = typeof IntersectionObserver !== 'undefined';
  const [inView, setInView] = useState(!supported);

  useEffect(() => {
    const node = ref.current;
    if (!supported || !node || inView) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [supported, inView]);

  return { ref, inView };
}
