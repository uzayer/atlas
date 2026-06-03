#!/usr/bin/env bash
# atlas-cli-version: {{VERSION}}
#
# Atlas CLI helper. Installed (and refreshed on every launch) by the
# Atlas IDE at `~/.local/bin/atlas`. Mirrors the `code` (VS Code) and
# `zed` (Zed) CLIs: run `atlas` in a terminal to open the current
# folder, or `atlas <path>` to open any directory.
#
# Re-installing Atlas overwrites this file in place — never hand-edit;
# changes won't survive a launch.

set -e

cmd="${1:-}"

case "$cmd" in
  --version|-v)
    echo "atlas {{VERSION}}"
    exit 0
    ;;
  --help|-h)
    cat <<'USAGE'
Usage:
  atlas              open the current directory in Atlas
  atlas <path>       open <path> in Atlas
  atlas --version    print the IDE version
  atlas --help       this message

Atlas opens each invocation as its own window so you can have many
projects in flight at once. The folder you pass must exist and be
readable.
USAGE
    exit 0
    ;;
esac

target="${1:-.}"

# Resolve to an absolute path. We deliberately use `cd && pwd` rather
# than `realpath` because realpath isn't on every macOS by default and
# this is portable.
if [ ! -d "$target" ]; then
  echo "atlas: not a directory: $target" >&2
  exit 1
fi
abs="$(cd "$target" && pwd)"

# Find Atlas.app. macOS first looks in /Applications, then
# ~/Applications, then PATH-y locations via `mdfind`. The latter
# covers DMG drag-installs to unusual locations.
app=""
for candidate in \
  "/Applications/Atlas.app" \
  "$HOME/Applications/Atlas.app"; do
  if [ -d "$candidate" ]; then
    app="$candidate"
    break
  fi
done
if [ -z "$app" ] && command -v mdfind >/dev/null 2>&1; then
  app="$(mdfind "kMDItemCFBundleIdentifier == 'com.atlas.ide'" 2>/dev/null | head -n 1)"
fi
if [ -z "$app" ]; then
  app="Atlas.app"  # let `open` resolve via LaunchServices as a fallback
fi

# `-n` forces a fresh process so argv is actually delivered — without it
# macOS just activates a running Atlas and drops the path. When Atlas is
# already open, that fresh process is intercepted by the single-instance
# plugin, which forwards the path to the existing window and exits (so no
# duplicate window appears); on a cold start it simply becomes the primary
# instance. `-a` selects the app explicitly; `--args` passes the rest to argv.
exec open -na "$app" --args "$abs"
