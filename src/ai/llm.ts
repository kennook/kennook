/**
 * Local LLM helper — runs a small instruction-tuned model via
 * @huggingface/transformers (the same ONNX backend as Whisper/SigLIP/Florence-2),
 * so there's no new native dependency and it stays cross-platform. The model
 * auto-downloads + caches on first use, exactly like the other passes.
 *
 * Currently used for transcript tagging: turning a video's spoken transcript
 * into a handful of topical tags. Unlike the keyword extractor in `voice.ts`
 * (compromise.js noun-picking), this infers *themes* — "we're down by the
 * water" can yield "beach", not just literal nouns.
 *
 * Perf note: this runs on CPU via onnxruntime-node (no Metal/CUDA in Node),
 * so it's in the seconds-per-item range. Fine for a batched enrichment job.
 *
 * Model choice: we wanted a ~3B model, but no ungated 3B is reliably published
 * as a transformers.js-ready ONNX build — Qwen2.5-3B/Phi-3.5 aren't public
 * under onnx-community, and Llama-3.2-3B is license-gated (needs an HF token +
 * accepted license to download, which breaks the zero-config story). So the
 * default is the strongest *ungated, auto-downloadable* option: Qwen2.5-1.5B,
 * which is excellent at instruction-following + JSON output. To run a true 3B,
 * accept the Llama-3.2-3B license on HF, export HF_TOKEN, and set MODEL to
 * 'onnx-community/Llama-3.2-3B-Instruct'.
 */

import { pipeline, env, type PipelineType } from '@huggingface/transformers';

if (process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

// Ungated, transformers.js-ready, ~1.5B instruct. 4-bit ONNX, ~1 GB download
// on first run. See the header note for the gated-3B upgrade path.
const MODEL = 'onnx-community/Qwen2.5-1.5B-Instruct';
// 4-bit weights — keeps the model small + CPU-friendly.
const DTYPE = 'q4' as const;

// Transcripts can be long (minutes of speech). Tag extraction only needs the
// gist, so cap the input to bound per-item latency — the head of a transcript
// is the most topical part anyway.
const MAX_TRANSCRIPT_CHARS = 6000;
// Below this much real (alphanumeric) content there's nothing to tag — Whisper
// emits artifacts like "(" or "[BLANK_AUDIO]" for near-silent clips, and handing
// those to the model just makes it hallucinate meta-tags. Skip inference instead.
const MIN_MEANINGFUL_CHARS = 15;
// Upper bounds on the tag set so one chatty video can't flood media_tags.
const MAX_TAGS = 12;
const MAX_TAG_WORDS = 3;

// Tags describing the *medium* rather than the content. The model sometimes
// emits these (especially on thin transcripts); they're never useful, so drop
// them post-hoc as a backstop to the prompt's instruction.
const META_STOPWORDS = new Set([
  'video', 'videos', 'transcript', 'transcripts', 'audio', 'recording',
  'recordings', 'footage', 'speech', 'spoken', 'content', 'clip', 'clips',
  'subtitle', 'subtitles', 'caption', 'captions',
]);

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
type TextGenerator = (
  input: ChatMessage[] | string,
  options?: Record<string, unknown>,
) => Promise<Array<{ generated_text: string | ChatMessage[] }>>;

let generatorPromise: Promise<TextGenerator> | null = null;
function getGenerator(): Promise<TextGenerator> {
  if (!generatorPromise) {
    generatorPromise = pipeline(
      'text-generation' as PipelineType,
      MODEL,
      { dtype: DTYPE },
    ) as unknown as Promise<TextGenerator>;
  }
  return generatorPromise;
}

const SYSTEM_PROMPT =
  'You extract concise topical tags from the spoken transcript of a video. ' +
  'Return ONLY a JSON array of short lowercase tags (1-3 words each) naming the ' +
  'main subjects, activities, places, people-roles, and themes actually discussed. ' +
  'Prefer the underlying topic over literal words (e.g. talk of waves and sand → "beach"). ' +
  'NEVER output tags describing the medium itself (e.g. "video", "audio", "transcript", ' +
  '"recording", "speech", "content"). ' +
  'No duplicates, no full sentences, no commentary, no markdown fences. ' +
  'If the transcript is empty, gibberish, or has no clear subject, return [].';

/** Pull the first JSON array out of model output and coerce to clean strings. */
function parseTagArray(raw: string): string[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((t): t is string => typeof t === 'string');
}

function normalizeTags(rawTags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rawTags) {
    const norm = raw
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (norm.length < 2) continue;
    if (norm.split(' ').length > MAX_TAG_WORDS) continue;
    if (META_STOPWORDS.has(norm)) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Extract topical tags from a transcript. Returns a normalized, deduped,
 * capped list (possibly empty). Never throws on model/parse weirdness — an
 * empty list just means "nothing confidently tag-worthy".
 */
export async function extractTranscriptTags(transcript: string): Promise<string[]> {
  const text = transcript.trim();
  if (!text) return [];

  // Substance gate: strip bracketed sound tokens + punctuation and require a
  // floor of real content. Near-silent clips yield artifacts like "(" or
  // "[BLANK_AUDIO]" — skip inference entirely so the model can't hallucinate.
  const meaningful = text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (meaningful.length < MIN_MEANINGFUL_CHARS) return [];

  const generator = await getGenerator();
  const clipped = text.length > MAX_TRANSCRIPT_CHARS
    ? text.slice(0, MAX_TRANSCRIPT_CHARS)
    : text;

  const output = await generator(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Transcript:\n\n${clipped}\n\nTags (JSON array):` },
    ],
    { max_new_tokens: 128, do_sample: false, temperature: 0, return_full_text: false },
  );

  const gen = output[0]?.generated_text;
  // With a messages-array input the pipeline returns the full conversation;
  // the assistant's reply is the last turn. With return_full_text:false on a
  // string input it'd be a bare string — handle both.
  const replyText = typeof gen === 'string'
    ? gen
    : Array.isArray(gen)
      ? (gen.at(-1)?.content ?? '')
      : '';

  return normalizeTags(parseTagArray(replyText));
}
