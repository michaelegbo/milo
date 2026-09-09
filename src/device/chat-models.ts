export const DEVICE_CHAT_MODELS = {
  fast: {
    label: 'Qwen 1.5B', model: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', bytes: 1_117_320_736,
    url: import.meta.env.VITE_DEVICE_FAST_MODEL_URL || '/models/chat/fast.gguf',
    license: 'Apache-2.0', maxTokens: 128,
  },
  quality: {
    label: 'Qwen 4B', model: 'Qwen/Qwen3-4B-GGUF', bytes: 2_497_280_256,
    // The server hosts static GGUF shards only; inference stays in this browser.
    url: import.meta.env.VITE_DEVICE_QUALITY_MODEL_URL || '/models/chat/quality-00001-of-00005.gguf',
    license: 'Apache-2.0', maxTokens: 160,
  },
} as const;
