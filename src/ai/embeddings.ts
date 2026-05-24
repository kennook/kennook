import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from '@huggingface/transformers';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';

if (process.env.TRANSFORMERS_CACHE) {
  env.cacheDir = process.env.TRANSFORMERS_CACHE;
}

let _imageEncoder: Promise<{
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
  model: Awaited<ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>>;
}> | null = null;

let _textEncoder: Promise<{
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof CLIPTextModelWithProjection.from_pretrained>>;
}> | null = null;

// Transformers.js v3 uses `dtype` (e.g. 'q8', 'fp16', 'fp32') in place of
// the old v2 `quantized: true` option. 'q8' picks an 8-bit quantized ONNX
// variant — fastest on CPU, ~4x smaller download.
const MODEL_OPTS = { dtype: 'q8' as const };

function loadImageEncoder() {
  if (_imageEncoder) return _imageEncoder;
  _imageEncoder = (async () => {
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(MODEL_ID),
      CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, MODEL_OPTS),
    ]);
    return { processor, model };
  })();
  return _imageEncoder;
}

function loadTextEncoder() {
  if (_textEncoder) return _textEncoder;
  _textEncoder = (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      CLIPTextModelWithProjection.from_pretrained(MODEL_ID, MODEL_OPTS),
    ]);
    return { tokenizer, model };
  })();
  return _textEncoder;
}

function normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

export async function embedImage(imagePath: string): Promise<Float32Array> {
  const { processor, model } = await loadImageEncoder();
  const image = await RawImage.read(imagePath);
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  return normalize(image_embeds.data as Float32Array);
}

export async function embedText(text: string): Promise<Float32Array> {
  const { tokenizer, model } = await loadTextEncoder();
  const inputs = tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await model(inputs);
  return normalize(text_embeds.data as Float32Array);
}

export function floatArrayToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
