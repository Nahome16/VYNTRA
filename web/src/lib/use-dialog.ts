"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableIn(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Comportamiento accesible de un dialogo modal:
 * - al abrir mueve el foco al primer control (o al propio dialogo),
 * - Escape cierra, Tab queda atrapado dentro del dialogo,
 * - al cerrar devuelve el foco al elemento que lo abrio.
 *
 * Se asigna el ref devuelto al elemento con role="dialog".
 */
export function useDialog<T extends HTMLElement = HTMLElement>(open: boolean, onClose: () => void) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const autoFocus = dialog.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
      const firstField = dialog.querySelector<HTMLElement>(
        "input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled])",
      );
      const target = autoFocus || firstField || focusableIn(dialog)[0] || dialog;
      if (target === dialog && !dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = focusableIn(dialogRef.current);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open]);

  return dialogRef;
}
