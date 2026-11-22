import { t } from "./i18n.js"

export interface Preset {
  label?: string // a brand name
  labelKey?: string // or a translated one (i18n.js)
  kind: "anthropic" | "openai" | "fake"
  base_url: string
  model: string
  models: string[]
  noteKey?: string
  devOnly?: boolean
}

export const PRESETS: Record<string, Preset> = {
  anthropic: { label: "Anthropic (Claude)", kind: "anthropic", base_url: "", model: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"], noteKey: "note.anthropic" },
  openai: { label: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1", model: "", models: [], noteKey: "note.openai" },
  deepseek: { label: "DeepSeek", kind: "openai", base_url: "https://api.deepseek.com/v1", model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"] },
  openrouter: { label: "OpenRouter", kind: "openai", base_url: "https://openrouter.ai/api/v1", model: "", models: [], noteKey: "note.openrouter" },
  litellm: { label: "LiteLLM Proxy", kind: "openai", base_url: "http://localhost:4000/v1", model: "", models: [], noteKey: "note.litellm" },
  qwen: { labelKey: "preset.qwen", kind: "openai", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus", models: ["qwen-plus", "qwen-max", "qwen-turbo"] },
  moonshot: { label: "Moonshot / Kimi", kind: "openai", base_url: "https://api.moonshot.cn/v1", model: "", models: [] },
  ollama: { labelKey: "preset.ollama", kind: "openai", base_url: "http://localhost:11434/v1", model: "", models: [], noteKey: "note.ollama" },
  custom: { labelKey: "preset.custom", kind: "openai", base_url: "", model: "", models: [] },
  fake: { labelKey: "preset.fake", kind: "fake", base_url: "", model: "fake", models: [], devOnly: true, noteKey: "note.fake" },
}

export const presetLabel = (p: Preset): string => p.label || t(p.labelKey!)
