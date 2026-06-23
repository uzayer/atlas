//! Provider + model picker pills for the native Atlas (Cersei) agent composer.
//!
//! The ACP agents (Claude Code / Codex) advertise their own models through the
//! agent process, but the in-process Cersei agent picks its provider+model from
//! the user's BYOK keys — so it needs the same two-pill selector the BYOK
//! model-chat tab uses. This mirrors `model-chat-panel`'s `PickerDropdown` +
//! `ModelCombo` (same data sources: the byok store, the providers catalog, and
//! the `modelchat_models` command), but curates the model list via the shared
//! coding-model catalog so strong coding models are pinned + starred at the top.

import { useEffect, useMemo, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Loader2, Search, Star } from "lucide-react";
import { ProviderLogo } from "@/components/provider-logo";
import { CHAT_PROVIDERS, providerById } from "@/features/settings/lib/providers";
import { useByokStore } from "@/features/settings/stores/byok-store";
import { modelchat } from "@/features/model-chat/lib/model-chat-api";
import {
  curateModels,
  defaultModelFor,
  isPreferredModel,
  preferredModels,
} from "@/features/review-agents/lib/model-catalog";
import { loadCerseiModelPref } from "../lib/cersei-model-pref";

// Curated model-list cache — `modelchat.models(provider)` hits the provider API,
// so cache the curated list per provider for the app session and dedupe
// in-flight requests (mirrors the cache in model-chat-panel). The list is run
// through `curateModels` so coding models rank first and embeddings/TTS/etc. are
// dropped.
const modelListCache = new Map<string, string[]>();
const modelListInFlight = new Map<string, Promise<string[]>>();
function loadModelIds(provider: string): Promise<string[]> {
  const cached = modelListCache.get(provider);
  if (cached) return Promise.resolve(cached);
  const inflight = modelListInFlight.get(provider);
  if (inflight) return inflight;
  const p = modelchat
    .models(provider)
    .then((rows) => {
      const curated = curateModels(provider, rows.map((r) => r.id));
      modelListCache.set(provider, curated);
      modelListInFlight.delete(provider);
      return curated;
    })
    .catch((e) => {
      modelListInFlight.delete(provider);
      throw e;
    });
  modelListInFlight.set(provider, p);
  return p;
}

const PILL_CLASS =
  "flex min-w-0 items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors outline-none cursor-pointer";

export function ProviderModelPills({
  provider,
  model,
  onProvider,
  onModel,
}: {
  provider: string;
  model: string;
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
}) {
  const keys = useByokStore.use.keys();
  const loaded = useByokStore.use.loaded();
  const { load } = useByokStore.use.actions();

  // Self-heal: make sure the BYOK keys are loaded before we read them.
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const configuredIds = useMemo(
    () => CHAT_PROVIDERS.filter((p) => !!keys[p.id]).map((p) => p.id),
    [keys],
  );

  // Last-used selection (persisted) — seeds a fresh composer so the picker
  // remembers the user's preference instead of resetting every new chat.
  const prefRef = useRef(loadCerseiModelPref());

  // Default the provider: the remembered one (if still configured), else the
  // first configured provider.
  useEffect(() => {
    if (provider || configuredIds.length === 0) return;
    const pref = prefRef.current;
    const next =
      pref && configuredIds.includes(pref.provider) ? pref.provider : configuredIds[0];
    onProvider(next);
  }, [provider, configuredIds, onProvider]);

  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return;
    }
    let cancelled = false;
    const apply = (ids: string[]) => {
      if (cancelled) return;
      setModels(ids);
      if (model || ids.length === 0) return;
      // Auto-select: the remembered model for this provider, else the catalog's
      // best default (first preferred coding model that's available).
      const pref = prefRef.current;
      const remembered =
        pref && pref.provider === provider && ids.includes(pref.model) ? pref.model : null;
      onModel(remembered ?? defaultModelFor(provider, ids) ?? ids[0]);
    };

    const cached = modelListCache.get(provider);
    if (cached) {
      apply(cached);
      setLoadingModels(false);
      return;
    }

    setLoadingModels(true);
    loadModelIds(provider)
      .then(apply)
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [provider, model, onModel]);

  if (loaded && configuredIds.length === 0) {
    return (
      <span
        className="flex items-center gap-1.5 px-2 h-6.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[10px] leading-none font-medium text-[var(--text-tertiary)] select-none"
        title="Add an API key in Settings → API Keys to use the Atlas agent"
      >
        No API key
      </span>
    );
  }

  return (
    <>
      <PickerDropdown
        trigger={
          <>
            <ProviderLogo id={provider} size={13} />
            <span className="max-w-[90px] truncate">
              {providerById(provider)?.name ?? provider ?? "Provider"}
            </span>
            <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
          </>
        }
      >
        {configuredIds.map((id) => (
          <DropdownMenu.Item
            key={id}
            onSelect={() => onProvider(id)}
            className="flex items-center gap-2 px-2.5 h-[28px] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer outline-none"
          >
            <ProviderLogo id={id} size={14} />
            <span className="flex-1 truncate">{providerById(id)?.name ?? id}</span>
            {id === provider && <Check size={12} className="text-[var(--text-primary)]" />}
          </DropdownMenu.Item>
        ))}
      </PickerDropdown>

      <ModelCombo
        provider={provider}
        models={models}
        value={model}
        loading={loadingModels}
        onSelect={onModel}
      />
    </>
  );
}

/** Small pill-shaped dropdown used for the provider picker. */
function PickerDropdown({
  trigger,
  children,
}: {
  trigger: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className={PILL_CLASS}>{trigger}</button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={6}
          className="z-[9999] max-h-[340px] min-w-[180px] overflow-y-auto rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] py-1 shadow-[var(--shadow-overlay)]"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Searchable model picker — preferred coding models are pinned + starred at the
 *  top, the rest follow below a divider. */
function ModelCombo({
  provider,
  models,
  value,
  loading,
  onSelect,
}: {
  provider: string;
  models: string[];
  value: string;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const { pinned, rest } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const match = (m: string) => (s ? m.toLowerCase().includes(s) : true);
    // Keep the catalog's preferred ordering for the pinned group.
    const order = preferredModels(provider);
    const pinnedSet = new Set(models.filter((m) => isPreferredModel(provider, m)));
    const pinned = order.filter((m) => pinnedSet.has(m) && match(m));
    const rest = models.filter((m) => !pinnedSet.has(m) && match(m));
    return { pinned, rest };
  }, [provider, models, q]);

  const renderItem = (id: string, starred: boolean) => (
    <button
      key={id}
      onClick={() => {
        onSelect(id);
        setOpen(false);
      }}
      className="flex w-full items-center gap-2 px-2.5 h-[26px] text-left text-[11px] font-mono text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer outline-none"
    >
      {starred && (
        <Star size={10} className="shrink-0 fill-[var(--accent-primary)] text-[var(--accent-primary)]" />
      )}
      <span className="flex-1 truncate">{id}</span>
      {id === value && <Check size={11} className="text-[var(--text-primary)]" />}
    </button>
  );

  const empty = pinned.length === 0 && rest.length === 0;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Popover.Trigger asChild>
        <button className={PILL_CLASS}>
          {loading && <Loader2 size={11} className="animate-spin text-[var(--text-tertiary)]" />}
          <span className="max-w-[160px] truncate font-mono">
            {value || (loading ? "Loading…" : "Select model")}
          </span>
          <ChevronDown size={11} className="text-[var(--text-tertiary)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={6}
          className="z-[9999] w-[260px] overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)]"
        >
          <div className="flex items-center gap-1.5 h-8 border-b border-[var(--border-subtle)] px-2.5">
            <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models…"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto hide-scrollbar py-1">
            {empty ? (
              <div className="px-2.5 py-2 text-[11px] text-[var(--text-tertiary)]">
                {loading ? "Loading…" : "No models"}
              </div>
            ) : (
              <>
                {pinned.length > 0 && (
                  <>
                    <div className="flex items-center gap-1 px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                      <Star size={8} className="fill-[var(--accent-primary)] text-[var(--accent-primary)]" />
                      Recommended for coding
                    </div>
                    {pinned.map((id) => renderItem(id, true))}
                    {rest.length > 0 && (
                      <div className="my-1 h-px bg-[var(--border-subtle)]" />
                    )}
                  </>
                )}
                {rest.map((id) => renderItem(id, false))}
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
