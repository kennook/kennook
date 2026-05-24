'use client';

import { useState, useEffect } from 'react';

interface Props {
  initial?: string;
  onSubmit: (q: string) => void;
}

export function SearchBar({ initial = '', onSubmit }: Props) {
  const [value, setValue] = useState(initial);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
      className="w-full"
    >
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder='Search your library — "beach trips", "the dog", "kitchen at sunset"...'
          className="w-full bg-zinc-900/80 border border-zinc-800 rounded-xl px-5 py-3.5 pr-12
                     text-base placeholder:text-zinc-500 focus:border-zinc-600 focus:bg-zinc-900
                     outline-none transition"
          autoFocus
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              setValue('');
              onSubmit('');
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200
                       text-lg leading-none px-1"
            aria-label="Clear"
          >
            ×
          </button>
        )}
      </div>
    </form>
  );
}
