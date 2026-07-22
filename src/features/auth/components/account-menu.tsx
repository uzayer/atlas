import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Keyboard, LayoutTemplate, Palette, Settings, Zap } from "lucide-react";

import { KbdCombo } from "@/ui/kbd";
import { openSettingsSection } from "@/features/settings/lib/open-settings";
import type { SettingsSection } from "@/features/settings/stores/settings-nav-store";
import type { AccountUser } from "../lib/auth-api";
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

const ITEM_CLASS =
  "flex items-center gap-2 px-3 h-[26px] text-[11px] cursor-default outline-none " +
  "text-[var(--text-secondary)] data-[highlighted]:bg-[var(--bg-hover)] " +
  "data-[highlighted]:text-[var(--text-primary)]";

/**
 * The menu behind the title bar's avatar — who you are, and the parts of
 * Settings people actually reach for.
 *
 * Wraps the account button rather than replacing it, so signed out the button
 * keeps its plain click-to-sign-in behaviour and this component is simply not
 * rendered. Escape, click-away, arrow keys and type-ahead come from Radix, the
 * same primitive every other Atlas menu uses.
 */
export function AccountMenu({
  user,
  children,
}: {
  /**
   * `null` in the narrow window between holding a credential and the first
   * successful profile fetch (see `SignedIn.user`). The menu still opens — its
   * destinations do not depend on identity, and this is where signing out will
   * live — but there is no header to render, and inventing a placeholder name
   * would be worse than the gap it fills.
   */
  user: AccountUser | null;
  children: ReactNode;
}) {
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
      <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-default)]" />
    </>
  );
}
