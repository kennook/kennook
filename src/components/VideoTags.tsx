'use client';

/**
 * Whole-item tags for the maximized viewer — the existing item-level tag
 * system ("party", "animals", …), surfaced in the (i) info panel for photos
 * and videos alike. Not timestamped (unlike bookmarks); these plug straight
 * into the tag facets + search that already exist.
 *
 * `focusSignal` (bumped by the parent's Add-tag shortcut) focuses the input.
 * Adding a tag (Enter) keeps the panel open + the field focused so you can add
 * several; `onDone` fires only on Escape (which also blurs) so the parent closes
 * the panel — and the released focus lets the next `i`/shortcut work again.
 */

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc-client';
import { useSyncEvent } from '@/lib/sync';
import { VoiceTagButton } from './VoiceTagButton';
import { FEATURES } from '@/lib/feature-flags';

interface Props {
  uuid: string;
  librarySlug: string;
  /** Bump to focus the tag input (the Add-tag shortcut does this). */
  focusSignal?: number;
  /** Fired when the user finishes tagging (Escape) so the parent can close the
   *  panel. Adding a tag (Enter) does NOT fire this — the panel stays open for
   *  the next tag. */
  onDone?: () => void;
}

export function VideoTags({ uuid, librarySlug, focusSignal, onDone }: Props) {
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
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus (and select) the input whenever the parent bumps `focusSignal` — the
  // Add-tag shortcut opens the panel and lands the cursor here. Skip the initial
  // 0/undefined so it doesn't steal focus on mount.
  useEffect(() => {
    if (!focusSignal) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusSignal]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const names = Array.from(new Set(
      input.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    ));
    if (!names.length) return;
    for (const name of names) addTag.mutate({ uuid, librarySlug, name });
    setInput('');
    // Keep the panel open + the field focused so you can add another tag; the
    // user finishes with Escape (onDone). Closing here would leave the hidden
    // field focused and swallow the next `i`/shortcut keypress.
    inputRef.current?.focus();
  };

  const list = tags.data ?? [];

  return (
    <div data-kn-chrome="" className="flex flex-col gap-1.5">
      <div className="text-xs uppercase text-zinc-500 tracking-wider">Tags</div>

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
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Escape cancels: blur, then let the parent close the panel if it
            // opened for a shortcut-initiated add.
            if (e.key === 'Escape') {
              e.stopPropagation();
              (e.currentTarget as HTMLInputElement).blur();
              onDone?.();
            }
          }}
          placeholder="party, animals…"
          maxLength={60}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px]
                     outline-none focus:border-zinc-600"
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

      {FEATURES.voiceTagging && (
        <VoiceTagButton
          uuid={uuid}
          librarySlug={librarySlug}
          onCommitted={(committed) => { if (committed.length > 0) invalidate(); }}
        />
      )}
    </div>
  );
}
