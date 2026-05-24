/**
 * Florence-2 vision-language model wrapper.
 *
 * One model, three things we care about per image:
 *   - DETAILED_CAPTION       → a natural-language description
 *   - OCR                    → all readable text in the image
 *   - DENSE_REGION_CAPTION   → list of objects/concepts present (used as tags)
 *
 * Runs locally via @huggingface/transformers (ONNX). Quantized weights are
 * ~250-300 MB on first download; cached to TRANSFORMERS_CACHE on subsequent
 * runs. ~1-3 seconds per task on Apple Silicon, ~3-8 seconds on CPU.
 */

import {
  AutoProcessor,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
  type PreTrainedTokenizer,
  type Tensor,
} from '@huggingface/transformers';

// Florence-2's processor has a post_process_generation() method that the base
// Processor type doesn't expose. Narrow shape we actually use:
interface Florence2Processor extends Processor {
  post_process_generation(
    text: string,
    task: string,
    imageSize: { width: number; height: number } | [number, number],
  ): Record<string, unknown>;
}

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

if (process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

interface VlmState {
  model: PreTrainedModel;
  processor: Processor;
  tokenizer: PreTrainedTokenizer;
}

let _state: Promise<VlmState> | null = null;

function loadModel(): Promise<VlmState> {
  if (_state) return _state;
  _state = (async () => {
    // q8 for the encoder/decoder. q4 produced garbage text (coordinate tokens
    // only — over-quantization). fp16 would be ideal but the upstream
    // onnx-community/Florence-2-base-ft has an invalid fp16 decoder graph.
    // q8 lands in the working middle: ~400MB total, correct text generation.
    const dtype = {
      embed_tokens: 'fp16',
      vision_encoder: 'fp16',
      encoder_model: 'q8',
      decoder_model_merged: 'q8',
    } as const;

    const [model, processor, tokenizer] = await Promise.all([
      Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, { dtype }),
      AutoProcessor.from_pretrained(MODEL_ID),
      AutoTokenizer.from_pretrained(MODEL_ID),
    ]);
    return { model, processor, tokenizer };
  })();
  return _state;
}

async function runTask<T = unknown>(imagePath: string, task: string): Promise<T> {
  const { model, processor, tokenizer } = await loadModel();
  const image = await RawImage.read(imagePath);

  // Florence-2's processor accepts (image, prompt) together and expands the
  // task token into the natural-language prompt the model was trained on
  // (e.g. <CAPTION> → "What does the image describe?"). Calling tokenizer()
  // directly on the task token produces character-level subwords that the
  // model can't interpret as a task, and it falls back to emitting region
  // coordinates. Always go through the processor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs = await (processor as any)(image, task);

  const generated = (await model.generate({
    ...inputs,
    max_new_tokens: 256,
    num_beams: 1,
    do_sample: false,
  })) as Tensor;

  const decoded: string = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
  const result = (processor as Florence2Processor).post_process_generation(
    decoded,
    task,
    image.size,
  );
  return result[task] as T;
}

export async function generateCaption(imagePath: string): Promise<string> {
  const text = await runTask<string>(imagePath, '<DETAILED_CAPTION>');
  return (text ?? '').trim();
}

export async function extractOcr(imagePath: string): Promise<string> {
  const text = await runTask<string>(imagePath, '<OCR>');
  const cleaned = (text ?? '').trim();
  // Filter Florence-2's low-confidence "I see digits" output for images that
  // contain no actual text — short strings of digits/punctuation only.
  // Require at least one Unicode letter (Latin OR CJK OR Arabic etc.).
  if (cleaned.length < 3 || !/\p{L}/u.test(cleaned)) return '';
  return cleaned;
}

export async function extractTags(imagePath: string): Promise<string[]> {
  const data = await runTask<{ bboxes?: number[][]; labels?: string[] }>(
    imagePath,
    '<DENSE_REGION_CAPTION>',
  );
  if (!data?.labels?.length) return [];
  // Florence-2's dense-region labels often repeat ("person", "person", "person")
  // — dedupe and normalize while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of data.labels) {
    const norm = raw.trim().toLowerCase();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

export interface Enrichment {
  caption: string;
  ocrText: string;
  tags: string[];
}

/**
 * Run all three enrichment tasks for a single image. Sequential because the
 * model state is shared and not safe to fan out in parallel.
 */
export async function enrichImage(imagePath: string): Promise<Enrichment> {
  const caption = await generateCaption(imagePath);
  const ocrText = await extractOcr(imagePath);
  const tags = await extractTags(imagePath);
  return { caption, ocrText, tags };
}
