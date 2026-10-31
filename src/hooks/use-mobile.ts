import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    // Subscribing to an external system (the viewport) — state updates happen
    // in the listener callback. The initial value is derived inside a
    // microtask (queueMicrotask) so no setState runs synchronously in the
    // effect body, which the upgraded react-hooks plugin flags as a
    // cascading-render hazard.
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    queueMicrotask(onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
