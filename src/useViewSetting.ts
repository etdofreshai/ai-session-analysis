import { useEffect, useState } from "react";

/** URL settings are temporary overrides; ordinary visits keep browser preferences. */
export function useViewSetting<T extends string>(
  storageKey: string,
  queryKey: string,
  choices: readonly T[],
  fallback: T,
) {
  const queryValue = new URLSearchParams(window.location.search).get(queryKey);
  const override = choices.includes(queryValue as T) ? queryValue as T : null;
  const [value, setValue] = useState<T>(() => {
    if (override !== null) return override;
    try {
      const saved = localStorage.getItem(storageKey);
      return choices.includes(saved as T) ? saved as T : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (override !== null) return;
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // The dashboard remains usable when browser storage is unavailable.
    }
  }, [storageKey, value, override]);

  return [value, setValue] as const;
}
