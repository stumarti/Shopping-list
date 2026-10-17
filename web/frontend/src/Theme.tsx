import { useState } from "react";

type Theme = "auto" | "light" | "dark";
const KEY = "shopping-list.theme";
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
const LABEL: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };
const ICON: Record<Theme, string> = { auto: "◐", light: "☀", dark: "☾" };

function saved(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "auto";
  } catch {
    return "auto";
  }
}

/** Light, dark, or follow the device. Tapping goes round the three; remembered on this device. */
export default function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(saved);
  const pick = () => {
    const t = NEXT[theme];
    setTheme(t);
    if (t === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // Not remembered on this device; it still changes now.
    }
  };
  return (
    <button className="theme-switch" onClick={pick} title={`Look: ${LABEL[theme]}. Tap for ${LABEL[NEXT[theme]]}.`} aria-label={`Light or dark: ${LABEL[theme]}. Tap to change.`}>
      <span aria-hidden="true">{ICON[theme]}</span> {LABEL[theme]}
    </button>
  );
}
