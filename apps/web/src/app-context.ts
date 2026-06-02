import { createContext, useContext } from "react";

/** App-level state that lives above the router: the per-tab id and the logout action. */
export interface AppContextValue {
  /** Per-tab id — the channel session's address + SSE registry key. Minted once per tab. */
  tab: string;
  logout: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used within AppProvider");
  return value;
}
