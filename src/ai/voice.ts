/**
 * Voice → tag pipeline. Two stages, each lazy-loaded so first call pays
 * the cost and every subsequent one is fast:
 *
 *   1. `transcribe(samples)` — runs whisper-tiny.en via
 *      @huggingface/transformers. Takes a Float32Array of 16 kHz mono
 *      PCM samples normalised to [-1, 1]. We pass samples directly
 *      rather than a file path because transformers.js's path/URL
 *      loader uses the browser-only AudioContext API and throws in
 *      Node. The caller is responsible for producing the Float32Array
 *      (usually by piping ffmpeg's `-f s16le -ar 16000 -ac 1` output
 *      through `pcmS16ToFloat32`).
 *
 *   2. `extractTags(text)` — compromise.js POS tagging. Pulls nouns
 *      (incl. proper nouns) from natural speech, normalises to
 *      singular + lowercase, dedupes, and drops length-1 tokens. The
 *      example "I see a boat in a beach in Venice" reduces to
 *      ["boat", "beach", "venice"] — exactly the user's spec.
 *
 * The combined helper `voiceToTags(samples)` chains them and returns
 * the final list plus the raw transcript (handy for debugging or for a
 * future "edit before commit" UI).
 */

import { pipeline, type PipelineType } from '@huggingface/transformers';
import nlp from 'compromise';

type Transcriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

// whisper-small.en (~250 MB quantized) — significantly more accurate
// than tiny/base for the short, noun-rich phrases users speak while
// tagging. First request downloads + caches; subsequent calls run in
// ~2-3 s on Apple Silicon. Step down to `whisper-base.en` if first-
// load latency is painful, or up to `whisper-medium.en` if accuracy
// still falls short (diminishing returns past small for this task).
const ASR_MODEL = 'Xenova/whisper-small.en';

let transcriberPromise: Promise<Transcriber> | null = null;
async function getTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    // The pipeline factory accepts a task name; cast to satisfy the
    // generic-typed `pipeline()` overload.
    transcriberPromise = pipeline(
      'automatic-speech-recognition' as PipelineType,
      ASR_MODEL,
    ) as unknown as Promise<Transcriber>;
  }
  return transcriberPromise;
}

/**
 * Convert raw signed-16-bit little-endian PCM bytes (ffmpeg's `s16le`
 * output) into a Float32Array of samples in [-1, 1] — the format
 * @huggingface/transformers expects when fed audio directly. We read
 * via `readInt16LE` rather than aliasing a typed array over the
 * Buffer's storage because Buffer.byteOffset isn't guaranteed to be
 * 2-byte aligned, which would crash an Int16Array constructor.
 */
export function pcmS16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = pcm.byteLength >>> 1;
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

export async function transcribe(samples: Float32Array): Promise<string> {
  const asr = await getTranscriber();
  const out = await asr(samples);
  const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
  return text.trim();
}

export interface TranscriptSegment {
  /** ms into the audio timeline. */
  startMs: number;
  /** ms into the audio timeline. */
  endMs: number;
  text: string;
}

/**
 * Whisper variant that returns per-segment timestamps. Used by the video
 * transcript enrichment to write per-chunk media_text_occurrences rows
 * so search can deep-link to "match at 0:45".
 *
 * Long audio is chunked internally by transformers.js — we just feed the
 * whole Float32Array and let it segment.
 */
export async function transcribeWithTimestamps(samples: Float32Array): Promise<{
  text: string;
  segments: TranscriptSegment[];
}> {
  const asr = await getTranscriber();
  // transformers.js whisper supports `return_timestamps: true` which returns
  // a `chunks` array of `{ timestamp: [start, end], text }`. The bare types
  // from the package don't reflect the option, so we widen via `unknown`.
  const out = (await (asr as unknown as (
    s: Float32Array,
    opts: Record<string, unknown>,
  ) => Promise<{ text: string; chunks?: Array<{ timestamp: [number, number]; text: string }> }>)
    (samples, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 }));

  const text = (out.text ?? '').trim();
  const segments: TranscriptSegment[] = (out.chunks ?? [])
    .filter((c) => Array.isArray(c.timestamp) && c.text)
    .map((c) => ({
      startMs: Math.round((c.timestamp[0] ?? 0) * 1000),
      endMs: Math.round((c.timestamp[1] ?? c.timestamp[0] ?? 0) * 1000),
      text: c.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  return { text, segments };
}

// Heuristics for what counts as a tag-worthy noun. Compromise sometimes
// catches sentence filler ("thing", "stuff", "kind", "lot") — strip those.
const TAG_STOPWORDS = new Set([
  'thing', 'things', 'stuff', 'kind', 'kinds', 'lot', 'lots', 'bit', 'bits',
  'something', 'anything', 'everything', 'one', 'ones',
  'guy', 'guys', 'person', 'people',
  // Whisper boilerplate that survives bracket-stripping. These would
  // never be useful tags; the values are post-normalisation (lowercase,
  // alphanumeric only).
  'blankaudio', 'blank_audio', 'silence', 'music', 'sound', 'noise',
  'inaudible', 'applause', 'laughter',
]);

/**
 * Whisper-tiny is notorious for hallucinating boilerplate phrases when
 * fed silence, noise, or just-barely-audible input. If a transcript is
 * EXACTLY one of these phrases (post-trim), treat it as "no speech".
 * Anchored to whole-string matches so a real sentence containing the
 * word "thanks" still gets tagged.
 */
const WHISPER_HALLUCINATIONS = [
  /^thanks?\s+for\s+watching!?$/i,
  /^thank\s+you\.?$/i,
  /^thanks?\.?$/i,
  /^bye!?$/i,
  /^you$/i,
  /^subtitles?\s+by.*$/i,
  /^♪+.*♪+$/,
  /^\.+$/,
];

/**
 * Strip whisper's bracketed sound-description tokens like `[BLANK_AUDIO]`,
 * `[Music]`, `(silence)`. These survive into the transcript as literal
 * text and would otherwise leak into the tag list.
 */
function stripBracketedTokens(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractTags(text: string): string[] {
  const cleaned = stripBracketedTokens(text);
  if (!cleaned) return [];
  if (WHISPER_HALLUCINATIONS.some((re) => re.test(cleaned))) return [];

  const doc = nlp(cleaned);
  const raw = doc.nouns().toSingular().out('array') as string[];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const n of raw) {
    const norm = n
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (norm.length < 2) continue;
    if (TAG_STOPWORDS.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    tags.push(norm);
  }
  return tags;
}

/**
 * Peak absolute amplitude. We use peak (not RMS) for silence detection
 * because hold-to-record clips almost always include ~0.5-1 s of
 * silence at the head/tail (button held before and after speech), and
 * averaging over the whole buffer dilutes real speech below an RMS
 * floor. Peak ignores duration entirely — if any single sample is loud,
 * there's audio content worth transcribing.
 *
 * Threshold of 0.05 ≈ -26 dBFS: room noise / mic preamp hum stays well
 * below, normal speech easily clears.
 */
function peak(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

const SILENCE_PEAK_THRESHOLD = 0.05;

export async function voiceToTags(samples: Float32Array): Promise<{
  transcript: string;
  tags: string[];
  peakAmplitude: number;
}> {
  const peakAmplitude = peak(samples);
  // Skip inference entirely for dead air — saves ~1 s of CPU and
  // prevents whisper from inventing a transcript to fill the void.
  if (peakAmplitude < SILENCE_PEAK_THRESHOLD) {
    return { transcript: '', tags: [], peakAmplitude };
  }
  const transcript = await transcribe(samples);
  const tags = extractTags(transcript);
  return { transcript, tags, peakAmplitude };
}
