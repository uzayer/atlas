import { create } from "zustand";

/** Cross-component signal to open the Settings tab on a specific section.
 *  Set `goTo(section)` before/after opening the (singleton, persistent) settings
 *  tab; `SettingsPanel` consumes it so the switch works whether the tab is
 *  freshly opened or already mounted on another section. */
interface SettingsNavState {
  section: string | null;
  goTo: (section: string) => void;
  clear: () => void;
}

export const useSettingsNav = create<SettingsNavState>((set) => ({
  section: null,
  goTo: (section) => set({ section }),
  clear: () => set({ section: null }),
}));
