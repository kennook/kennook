// Florence-2 sanity check. Runs each captioning/OCR task against a single
// image, dumping the raw tokenizer input, the raw decoded model output, and
// the post-processed result. Use this to isolate where a broken caption is
// coming from — wrong task token, wrong post-processor, bad quantization, etc.
//
// Usage:
//   pnpm tsx scripts/debug-vlm.ts <path-to-image-or-thumbnail>

import {
  AutoProcessor,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  RawImage,
  env,
} from '@huggingface/transformers';

if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: pnpm tsx scripts/debug-vlm.ts <path-to-image>');
    process.exit(1);
  }

  console.log('Loading Florence-2 base-ft (this can take a minute on first run)…');
  const model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype: {
      embed_tokens: 'fp16',
      vision_encoder: 'fp16',
      encoder_model: 'q8',
      decoder_model_merged: 'q8',
    },
  });
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);

  const image = await RawImage.read(imagePath);
  console.log(`Image: ${imagePath} (${image.width}×${image.height})\n`);

  const tasks = ['<CAPTION>', '<DETAILED_CAPTION>', '<MORE_DETAILED_CAPTION>', '<OCR>'];

  // Try TWO invocation patterns to see which one Florence-2 actually wants.
  for (const task of tasks) {
    console.log('═'.repeat(70));
    console.log(`TASK: ${task}`);
    console.log('═'.repeat(70));

    // Pattern A: combined processor call. Florence-2's processor knows how to
    // expand task tokens to the natural-language prompts the model was
    // trained with (e.g. <CAPTION> → "What does the image describe?")
    try {
      console.log('\n[Pattern A] processor(image, prompt) — combined call');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inputs = await (processor as any)(image, task);
      const ids = Array.from((inputs.input_ids?.data ?? []) as number[]).slice(0, 16);
      console.log(`input_ids first 16: [${ids.join(', ')}]`);

      const generated = (await model.generate({
        ...inputs,
        max_new_tokens: 128,
        num_beams: 1,
        do_sample: false,
      })) as import('@huggingface/transformers').Tensor;
      const decoded = tokenizer.batch_decode(generated, { skip_special_tokens: false })[0];
      console.log('RAW decoded:', JSON.stringify(decoded));
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (processor as any).post_process_generation(decoded, task, image.size);
        console.log('Result:', JSON.stringify(result, null, 2));
      } catch (e) {
        console.log('Post-process error:', e instanceof Error ? e.message : e);
      }
    } catch (err) {
      console.log('Pattern A failed:', err instanceof Error ? err.message : err);
    }

    // Pattern B: separate tokenizer + processor calls (what we had before).
    console.log('\n[Pattern B] tokenizer(prompt) + processor(image) — separate');
    const textInputs = tokenizer(task);
    const visionInputs = await processor(image);
    const generatedB = (await model.generate({
      ...textInputs,
      ...visionInputs,
      max_new_tokens: 128,
      num_beams: 1,
      do_sample: false,
    })) as import('@huggingface/transformers').Tensor;
    const decoded = tokenizer.batch_decode(generatedB, { skip_special_tokens: false })[0];
    console.log('RAW decoded:', JSON.stringify(decoded));

    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
