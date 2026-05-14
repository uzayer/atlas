import { useState, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useGitStore } from "@/features/git/stores/git-store";
import { GitBranch, Search, Plus, Trash2, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function BranchPopover() {
  const branch = useGitStore.use.branch();
  const branches = useGitStore.use.branches();
  const isRepo = useGitStore.use.isRepo();
  const { listBranches, checkout, createBranch, deleteBranch } =
    useGitStore.use.actions();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && isRepo) {
      listBranches();
    }
  }, [open, isRepo, listBranches]);

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCheckout = async (name: string) => {
    setLoading(true);
    try {
      await checkout(name);
    } catch {
      // handle error
    }
    setLoading(false);
    setOpen(false);
  };

  const handleCreate = async () => {
    if (!newBranch.trim()) return;
    setLoading(true);
    try {
      await createBranch(newBranch.trim());
      setNewBranch("");
    } catch {
      // handle error
    }
    setLoading(false);
    setOpen(false);
  };

  const handleDelete = async (name: string) => {
    try {
      await deleteBranch(name);
    } catch {
      // handle error
    }
  };

  if (!isRepo) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-1.5 px-1.5 h-5 rounded text-[11px] text-[#777] hover:text-[#aaa] hover:bg-[#ffffff08] transition-colors">
          <GitBranch size={11} />
          <span className="font-mono">{branch}</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          className="w-[240px] rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] shadow-xl"
          style={{ zIndex: "var(--z-max)" as unknown as number }}
        >
          {/* Search */}
          <div className="flex items-center gap-2 px-3 h-[32px] border-b border-[#1a1a1a]">
            <Search size={11} className="text-[#555] shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search branches..."
              className="flex-1 bg-transparent outline-none text-[11px] text-[#ccc] placeholder:text-[#444]"
              autoFocus
            />
          </div>

          {/* Branch list */}
          <div className="max-h-[200px] overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={14} className="animate-spin text-[#555]" />
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-3 text-[10px] text-[#444] text-center">
                No branches found
              </div>
            )}
            {!loading &&
              filtered.map((b) => (
                <div
                  key={b.name}
                  className={cn(
                    "group flex items-center gap-2 px-3 h-[28px] hover:bg-[#1a1a1a] cursor-default",
                    b.is_current && "bg-[#1a1a1a]"
                  )}
                >
                  <button
                    onClick={() => !b.is_current && handleCheckout(b.name)}
                    className="flex items-center gap-2 flex-1 min-w-0"
                    disabled={b.is_current}
                  >
                    {b.is_current ? (
                      <Check size={10} className="text-[#4d4] shrink-0" />
                    ) : (
                      <span className="w-[10px] shrink-0" />
                    )}
                    <span
                      className={cn(
                        "text-[11px] font-mono truncate",
                        b.is_current ? "text-[#ccc]" : "text-[#888]"
                      )}
                    >
                      {b.name}
                    </span>
                  </button>
                  {!b.is_current && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(b.name);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-[#555] hover:text-[#e55] transition-colors"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              ))}
          </div>

          {/* New branch */}
          <div className="flex items-center gap-2 px-3 h-[32px] border-t border-[#1a1a1a]">
            <Plus size={11} className="text-[#555] shrink-0" />
            <input
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="New branch..."
              className="flex-1 bg-transparent outline-none text-[11px] text-[#ccc] placeholder:text-[#444]"
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
