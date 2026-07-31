'use client';

import { trpc } from '@/lib/trpc-client';

/**
 * Face-framing debug inset (toggled with ` in the full-screen viewer). Shows the
 * item at its NATIVE aspect with the detected face boxes drawn on it and the
 * stored focal point as a crosshair — so you can see, on any off-centre photo,
 * whether it's "no face detected" (→ centre-crop fallback), a bad box, or a face
 * near an edge (a cover-crop limit). Uses a small inset rather than overlaying the
 * zoomed/panned main image so the coordinates always line up.
 */
export function FaceDebugOverlay({
  uuid, librarySlug, previewUrl,
}: { uuid: string; librarySlug: string; previewUrl: string }) {
  const q = trpc.media.faceBoxes.useQuery({ uuid, librarySlug }, { staleTime: 30_000 });
  const data = q.data;
  const w = data?.width ?? 0;
  const h = data?.height ?? 0;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div className="absolute top-4 left-4 z-40 w-64 max-w-[40vw] select-none">
      <div
        className="relative rounded-md overflow-hidden ring-1 ring-emerald-500/60 bg-black shadow-2xl"
        style={{ aspectRatio: w > 0 && h > 0 ? `${w} / ${h}` : '1 / 1' }}
      >
        {/* Native-aspect image (aspect matches container → no crop, unlike the
            cover-cropped grid thumbnail). */}
        <img src={previewUrl} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />

        {/* Detected face boxes. */}
        {data?.faces.map((f, i) => (
          <div
            key={i}
            className="absolute border-2 border-sky-400/90"
            style={{ left: pct(f.x), top: pct(f.y), width: pct(f.w), height: pct(f.h) }}
            title={f.confidence != null ? `conf ${(f.confidence).toFixed(2)}` : undefined}
          />
        ))}

        {/* Stored focal point — the point the crop/pan anchors on. */}
        {data?.focusX != null && data?.focusY != null && (
          <>
            <div className="absolute h-px bg-emerald-400/80" style={{ left: 0, right: 0, top: pct(data.focusY) }} />
            <div className="absolute w-px bg-emerald-400/80" style={{ top: 0, bottom: 0, left: pct(data.focusX) }} />
            <div
              className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] rounded-full bg-emerald-400 ring-2 ring-black"
              style={{ left: pct(data.focusX), top: pct(data.focusY) }}
            />
          </>
        )}
      </div>

      <div className="mt-1 text-[10px] font-mono text-zinc-300 bg-black/80 rounded px-1.5 py-1 leading-relaxed">
        {q.isLoading ? 'loading faces…' : !data ? 'no data' : (
          <>
            faces: <span className="text-sky-300">{data.faces.length}</span>
            {' · '}status: <span className="text-zinc-400">{data.faceStatus ?? '—'}</span><br />
            focus: {data.focusX != null && data.focusY != null
              ? <span className="text-emerald-300">{data.focusX.toFixed(3)}, {data.focusY.toFixed(3)}</span>
              : <span className="text-amber-300">none → centre crop</span>}
          </>
        )}
      </div>
    </div>
  );
}
