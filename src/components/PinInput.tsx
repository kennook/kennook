'use client';

/**
 * Segmented numeric PIN entry — N single-digit boxes that behave like one
 * field. Controlled: `value` is a left-packed digit string, `onChange` gets
 * the new value, and `onComplete` fires once it reaches `length`.
 *
 * Entry is strictly left-to-right (no gaps): typing appends, Backspace pops,
 * paste distributes, and focusing any box redirects to the first empty one.
 * Good enough for a 4-digit passcode; not a general-purpose OTP editor.
 */

import { useEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  error?: boolean;
  onComplete?: (v: string) => void;
  ariaLabel?: string;
}

export function PinInput({
  value,
  onChange,
  length = 4,
  autoFocus,
  disabled,
  error,
  onComplete,
  ariaLabel = 'Passcode',
}: Props) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusIndex = (i: number) => refs.current[i]?.focus();

  // Focus the first box on mount when asked. An effect (+rAF) is more reliable
  // than the native autoFocus attribute when this mounts mid-gesture (e.g. the
  // screensaver unlock prompt appearing on the dismiss click); remounting via
  // a changed `key` re-runs this to refocus after a wrong attempt.
  useEffect(() => {
    if (!autoFocus) return;
    const raf = requestAnimationFrame(() => refs.current[0]?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);

  const emit = (next: string) => {
    const clean = next.replace(/\D/g, '').slice(0, length);
    onChange(clean);
    focusIndex(Math.min(clean.length, length - 1));
    if (clean.length === length) onComplete?.(clean);
  };

  const onBoxChange = (raw: string) => {
    const d = raw.replace(/\D/g, '');
    if (d) emit(value + d); // append (handles multi-char paste into a box too)
  };

  const onBoxKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      if (value.length) emit(value.slice(0, -1));
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    emit(value + e.clipboardData.getData('text'));
  };

  return (
    <div className="flex gap-2 justify-center" onPaste={onPaste}>
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={1}
          disabled={disabled}
          value={value[i] ?? ''}
          aria-label={`${ariaLabel} digit ${i + 1}`}
          onChange={(e) => onBoxChange(e.target.value)}
          onKeyDown={onBoxKeyDown}
          className={`w-12 h-14 text-center text-xl font-medium tabular-nums rounded-md
                      bg-zinc-900 border outline-none transition-colors disabled:opacity-50
                      ${error ? 'border-red-500/70' : 'border-zinc-700 focus:border-zinc-500'}`}
        />
      ))}
    </div>
  );
}
