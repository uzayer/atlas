import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Keyboard,
  LayoutTemplate,
  LogOut,
  Palette,
  Settings,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { KbdCombo } from "@/ui/kbd";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { SettingsSection } from "@/features/settings/stores/settings-nav-store";
import {
  ROLE_LABELS,
  type AccountOrg,
  type AccountUser,
  type SignedIn,
} from "../lib/auth-api";
import { useAuthStore } from "../stores/auth-store";
import { AccountAvatar } from "./account-avatar";

/**
 * The account menu's destinations.
 *
 * `label` is what the user is looking for and `section` is where it lives —
 * "Themes" is the Appearance section, not one of its own.
 *
 * `shortcut` is set only where Atlas really binds one, so a hint here always
 * survives being pressed.
 */
const ITEMS: Array<{
  label: string;
  icon: typeof Settings;
  section: SettingsSection;
  shortcut?: string;
}> = [
  { label: "Settings", icon: Settings, section: "general", shortcut: "⌘," },
  { label: "Keybindings", icon: Keyboard, section: "keybindings" },
  { label: "Themes", icon: Palette, section: "appearance" },
  { label: "Skills", icon: Zap, section: "skills" },
  { label: "Layouts", icon: LayoutTemplate, section: "layouts" },
];

// Same shape as the composer's "+" menu, so every Atlas dropdown reads alike.
// `--z-max` matches the sidebar's add-project menu: the content is portalled to
// `body`, so it is not competing with the title bar, but it does share a
// stacking context with every dialog and overlay in the app.
const CONTENT_CLASS =
  "z-[var(--z-max)] min-w-[228px] max-w-[300px] rounded-md border border-[var(--border-default)] " +
  "bg-[var(--bg-secondary)] shadow-[var(--shadow-overlay)] py-1";

/**
 * Shown when the background revocation did not land — offline, or an Atlas
 * outage.
 *
 * States the residual risk instead of implying a clean revocation, because the
 * session is a 7-day rolling credential: "may stay active until it expires" is
 * a real window, and only the user can judge whether it matters on the machine
 * they are walking away from.
 */
const RESIDUAL_SESSION =
  "Signed out on this device. Your Atlas session may stay active on the server until it expires.";

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

// Hoisted for the same reason as the two above: this menu now has three
// separators, and a rule one of them disagreed with would be visible.
const SEPARATOR_CLASS = "my-1 h-px bg-[var(--border-default)]";

/**
 * The menu behind the title bar's avatar — who you are, the parts of Settings
 * people actually reach for, and the way out.
 *
 * Wraps the account button rather than replacing it, so signed out the button
 * keeps its plain click-to-sign-in behaviour and this component is simply not
 * rendered. Escape, click-away, arrow keys and type-ahead come from Radix, the
 * same primitive every other Atlas menu uses.
 */
export function AccountMenu({
  account,
  children,
}: {
  /**
   * The whole signed-in snapshot rather than its pieces, so the menu cannot be
   * handed an identity and a set of organisations that came from different
   * moments.
   *
   * `account.user` is `null` in the narrow window between holding a credential
   * and the first successful profile fetch (see `SignedIn.user`). The menu still
   * opens, and Sign Out still works — neither depends on identity, and a
   * credential we cannot put a name to is still one the user must be able to
   * disconnect. There is simply no header to render, and inventing a placeholder
   * name would be worse than the gap it fills.
   */
  account: SignedIn;
  children: ReactNode;
}) {
  const { signOut } = useAuthStore.use.actions();
  const { user, orgs, activeOrgId } = account;

  // Not awaited by anything on screen: the title bar has already flipped by the
  // time this promise settles, off the state event Rust emits before it touches
  // the network. All that arrives here is whether a caveat is owed.
  const onSignOut = async () => {
    if (!(await signOut())) toast.warning(RESIDUAL_SESSION);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={CONTENT_CLASS}
        >
          {user && <Header user={user} />}
          {/* Omitted entirely while the organisations are unknown — see
              `SignedIn.orgs`. Same reasoning as the header above it. */}
          {orgs && (
            <Organisation
              active={orgs.find((org) => org.id === activeOrgId) ?? null}
            />
          )}
          {ITEMS.map((item) => (
            <DropdownMenu.Item
              key={item.section}
              onSelect={() => openSettingsSection(item.section)}
              className={ITEM_CLASS}
            >
              <item.icon
                size={13}
                className="shrink-0 text-[var(--text-tertiary)]"
              />
              <span className="flex-1 text-left">{item.label}</span>
              {item.shortcut && <KbdCombo combo={item.shortcut} />}
            </DropdownMenu.Item>
          ))}
          {/* Separated from the destinations above: everything else in this
              menu navigates, and this one ends the session. Rendered whether or
              not there is an identity to show — a credential held with no
              profile yet is still one the user must be able to disconnect. */}
          <DropdownMenu.Separator className={SEPARATOR_CLASS} />
          <DropdownMenu.Item onSelect={() => void onSignOut()} className={ITEM_CLASS}>
            <LogOut size={13} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="flex-1 text-left">Sign Out</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Which organisation this device is acting for, and the role it carries there
 * (ATL-51).
 *
 * A `Label`, not an `Item`: this section is read-only, and rendering it as an
 * item would make it focusable, highlightable, and reachable by type-ahead —
 * every affordance of something you can act on, for something you cannot.
 * Switching organisations is ATL-36's.
 *
 * `active` is `null` for a user who belongs to none. That is a real answer and
 * gets a plain sentence, not a blank row or a spinner: nothing is loading, and
 * nothing is wrong.
 *
 * No plan or tier badge, deliberately. The mockup had one; the server has no
 * billing, subscription, or plan concept anywhere, so a hardcoded "Free" would
 * be untrue from the first commit and would quietly stay untrue after billing
 * ships.
 */
function Organisation({ active }: { active: AccountOrg | null }) {
  return (
    <>
      <DropdownMenu.Label className="px-3 pt-1 pb-1.5">
        {/* Same caption shape as the provider picker's section labels, so
            dropdown sections read alike across the app. */}
        <div className="text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
          Organisation
        </div>
        {active ? (
          // Name and role on one row, mirroring the shortcut rows below: the
          // name takes the space and truncates, the role never wraps.
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">
              {active.name}
            </span>
            {/* Absent when the claim named no role, or one this build does not
                know — the organisation is still real, so it is still shown. */}
            {active.role && (
              <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                {ROLE_LABELS[active.role]}
              </span>
            )}
          </div>
        ) : (
          <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
            No organisation
          </div>
        )}
      </DropdownMenu.Label>
      <DropdownMenu.Separator className={SEPARATOR_CLASS} />
    </>
  );
}

/** Avatar, name and email — the "who am I signed in as" answer. */
function Header({ user }: { user: AccountUser }) {
  // A name is not guaranteed: some providers give us only an address. Falling
  // back to the email keeps the primary line filled rather than showing a blank
  // row above the address, and the second line is dropped when it would just
  // repeat the first.
  const name = user.name.trim();
  const email = user.email.trim();
  const primary = name || email;

  return (
    <>
      {/* `Label`, not a bare div: inside `role="menu"` an unlabelled block is
          announced as loose text between the items. This is the menu's title. */}
      <DropdownMenu.Label className="flex items-center gap-2.5 px-3 py-1.5">
        <AccountAvatar user={user} size={28} />
        {/* `flex-1 min-w-0` against the content's max width is what makes a
            long address truncate rather than stretch the whole menu. */}
        <div className="flex-1 min-w-0">
          <div className="truncate text-[11.5px] font-medium text-[var(--text-primary)]">
            {primary}
          </div>
          {email && email !== primary && (
            <div className="truncate text-[10.5px] text-[var(--text-tertiary)]">
              {email}
            </div>
          )}
        </div>
      </DropdownMenu.Label>
      <DropdownMenu.Separator className={SEPARATOR_CLASS} />
    </>
  );
}
