/*
 * Logotipo VYNTRA: palabra en mayúsculas geométricas con la A sin travesaño (Λ).
 * Trazado vectorial a partir de la exploración de marca; altura de mayúsculas = 100.
 * Los trazos verticales miden 19 y los horizontales 17 (corrección óptica).
 */

const LETTER_V = "M0 0H21L50.9 72.2L80.8 0H101.8L60.4 100H41.4Z";
const LETTER_Y = "M110.3 0H132.3L158.75 41.7L185.2 0H207.2L168.25 61V100H149.25V61Z";
const LETTER_N = "M219.5 0H238.5L290.5 67V0H309.5V100H292L238.5 31.1V100H219.5Z";
const LETTER_T = "M324 0H409V17H376V100H357V17H324Z";
const LETTER_R = "M424 0H473A32 32 0 0 1 485.6 61.4L510 100H487L463 64H443V100H424ZM443 17V47H471A15 15 0 0 0 471 17Z";
const LETTER_A = "M517 100L560 0H579.5L622.5 100H602L569.75 25L537.5 100Z";

export const VYNTRA_WORDMARK_PATH = [LETTER_V, LETTER_Y, LETTER_N, LETTER_T, LETTER_R, LETTER_A].join("");
export const VYNTRA_MARK_PATH = LETTER_V;

type BrandProps = {
  className?: string;
  /** Texto accesible; si se omite, el logotipo es decorativo. */
  title?: string;
};

export function VyntraWordmark({ className, title }: BrandProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 622.5 100"
      fill="currentColor"
      fillRule="evenodd"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={VYNTRA_WORDMARK_PATH} />
    </svg>
  );
}

/** Monograma (la V del logotipo) para espacios cuadrados pequeños. */
export function VyntraMark({ className, title }: BrandProps) {
  return (
    <svg
      className={className}
      viewBox="-10 -10 121.8 120"
      fill="currentColor"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d={VYNTRA_MARK_PATH} />
    </svg>
  );
}
