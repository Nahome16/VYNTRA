"use client";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Language, STORAGE_KEYS, Theme, translate } from "@/lib/i18n";

type PreferencesValue = {
  language: Language;
  theme: Theme;
  setLanguage: (value: Language) => void;
  toggleLanguage: () => void;
  setTheme: (value: Theme) => void;
  toggleTheme: () => void;
  /** Traduce una cadena de interfaz al idioma activo. */
  t: (text: string) => string;
};

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "dark" ? "dark" : "light";
}

function readLanguage(): Language {
  if (typeof window === "undefined") return "es";
  const stored = window.localStorage.getItem(STORAGE_KEYS.language);
  return stored === "en" ? "en" : "es";
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>("es");
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLanguageState(readLanguage());
      setThemeState(readTheme());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setTheme = useCallback((value: Theme) => {
    setThemeState(value);
    document.documentElement.setAttribute("data-theme", value);
    try {
      window.localStorage.setItem(STORAGE_KEYS.theme, value);
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  const setLanguage = useCallback((value: Language) => {
    setLanguageState(value);
    document.documentElement.setAttribute("lang", value);
    try {
      window.localStorage.setItem(STORAGE_KEYS.language, value);
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);

  const value = useMemo<PreferencesValue>(
    () => ({
      language,
      theme,
      setLanguage,
      setTheme,
      toggleLanguage: () => setLanguage(language === "es" ? "en" : "es"),
      toggleTheme: () => setTheme(theme === "light" ? "dark" : "light"),
      t: (text: string) => translate(language, text),
    }),
    [language, setLanguage, setTheme, theme],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}

/** Atajo para traducir sin desestructurar todo el contexto. */
export function useT() {
  return usePreferences().t;
}
