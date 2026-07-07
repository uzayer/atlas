import { useByokStore } from "@/features/settings/stores/byok-store";
import { loadCerseiModelPref } from "./cersei-model-pref";

/** A one-click BYOK (provider, model) for the adaptive card's LLM features
 *  (diagram / next-step chips / commit message): the user's last-picked model,
 *  only when its provider still has a configured key. `null` → the feature is
 *  gated off. No interactive picker needed. */
export function resolveByok(): { provider: string; model: string } | null {
  const pref = loadCerseiModelPref();
  if (!pref?.provider || !pref?.model) return null;
  if (!useByokStore.getState().keys[pref.provider]) return null;
  return pref;
}
