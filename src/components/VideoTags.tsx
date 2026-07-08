'use client';

/**
 * Whole-video tags for the maximized viewer — the existing item-level tag
 * system ("party", "animals", …), surfaced where the details sidebar isn't
 * (immersive / slideshow). Not timestamped (unlike bookmarks); these plug
 * straight into the tag facets + search that already exist.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { useSyncEvent } from '@/lib/sync';

interface Props {
  uuid: string;
  librarySlug: string;
}

export function VideoTags({ uuid, librarySlug }: Props) {
  const utils = trpc.useUtils();
  const tags = trpc.media.listTags.useQuery({ uuid, librarySlug });
  const invalidate = () => {
    void utils.media.listTags.invalidate({ uuid, librarySlug });
    void utils.media.facets.invalidate();
  };
  // Converge when another window/device edits this item's tags.
  useSyncEvent('item.tag.changed', (e) => {
    if (e.uuid === uuid) void utils.media.listTags.invalidate({ uuid, librarySlug });
  });

  const addTag = trpc.media.addUserTag.useMutation({ onSuccess: invalidate });
  const removeTag = trpc.media.removeUserTag.useMutation({ onSuccess: invalidate });
  const [input, setInput] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const names = Array.from(new Set(
      input.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    ));
    if (!names.length) return;
    for (const name of names) addTag.mutate({ uuid, librarySlug, name });
    setInput('');
  };

  const list = tags.data ?? [];

  return (
    <div
      data-kn-chrome=""
      className="w-64 bg-zinc-950/90 backdrop-blur ring-1 ring-zinc-800 rounded-lg p-3
                 text-sm shadow-2xl flex flex-col gap-2"
    >
      <div className="text-xs text-zinc-400">Video tags</div>

      {list.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {list.map((t) => {
            const isUser = t.source === 'user';
            return (
              <span
                key={`${t.source}-${t.name}`}
                className={`px-1.5 py-0.5 rounded text-[10px] border inline-flex items-center gap-1
                            ${isUser
                              ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700/50'
                              : 'bg-zinc-800 text-zinc-300 border-zinc-700/50'}`}
              >
                {t.name}
                {isUser && (
                  <button
                    onClick={() => removeTag.mutate({ uuid, librarySlug, name: t.name })}
                    disabled={removeTag.isPending}
                    className="text-emerald-500 hover:text-emerald-200 leading-none ml-0.5"
                    title="Remove tag"
                    aria-label="Remove tag"
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <form onSubmit={submit} className="flex items-center gap-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur(); }}
          placeholder="party, animals…"
          maxLength={60}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-[11px]
                     outline-none focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={!input.trim() || addTag.isPending}
          className="text-[11px] text-zinc-400 hover:text-zinc-100 disabled:opacity-30 px-2 py-1"
        >
          Add
        </button>
      </form>
      {addTag.error && <div className="text-[10px] text-red-400">{addTag.error.message}</div>}
    </div>
  );
}
