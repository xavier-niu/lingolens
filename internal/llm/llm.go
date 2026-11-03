// Package llm implements bring-your-own-key LLM access.
//
// Provider kinds:
//   - "openai":    any OpenAI-compatible Chat Completions API — OpenAI, DeepSeek,
//     OpenRouter, LiteLLM proxy, Qwen, Moonshot, Ollama, vLLM, ...
//   - "anthropic": Claude via the official Anthropic Go SDK.
//   - "fake":      offline stand-in for development (only when explicitly enabled).
//
// API keys arrive with each request from the browser and are never stored or logged.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

type Config struct {
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Model   string `json:"model"`
}

type Message struct {
	Role    string `json:"role"` // "user" | "assistant"
	Content string `json:"content"`
}

// Error is a user-facing provider error with an HTTP-ish status.
type Error struct {
	Msg    string
	Status int
}

func (e *Error) Error() string { return e.Msg }

func errorf(status int, format string, args ...any) *Error {
	return &Error{Msg: fmt.Sprintf(format, args...), Status: status}
}

type Client interface {
	// CompleteJSON runs a one-shot completion and returns the JSON object it produced.
	CompleteJSON(ctx context.Context, system, user string, schema map[string]any) ([]byte, error)
	// StreamChat runs a multi-turn chat, calling onDelta for each text fragment.
	StreamChat(ctx context.Context, system string, msgs []Message, onDelta func(string) error) error
}

// New returns a client for cfg. Fake clients are only allowed when allowFake is set.
func New(cfg Config, allowFake bool, httpClient *http.Client) (Client, error) {
	cfg.BaseURL = strings.TrimSpace(cfg.BaseURL)
	cfg.Model = strings.TrimSpace(cfg.Model)
	cfg.APIKey = strings.TrimSpace(cfg.APIKey)
	switch cfg.Kind {
	case "anthropic":
		if cfg.APIKey == "" {
			return nil, errorf(http.StatusUnauthorized, "An Anthropic API key is required. Open Settings to add one.")
		}
		return newAnthropic(cfg), nil
	case "openai", "":
		if cfg.Model == "" {
			return nil, errorf(http.StatusBadRequest, "Set a model name in Settings.")
		}
		return &openAIClient{cfg: cfg, http: httpClient}, nil
	case "fake":
		if allowFake {
			return fakeClient{}, nil
		}
	}
	return nil, errorf(http.StatusBadRequest, "Unknown provider kind %q.", cfg.Kind)
}

var fenceRe = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)```")

// ExtractJSON pulls a JSON object out of model output that may contain code fences or prose.
func ExtractJSON(text string) ([]byte, error) {
	text = strings.TrimSpace(text)
	if m := fenceRe.FindStringSubmatch(text); m != nil {
		text = strings.TrimSpace(m[1])
	}
	if json.Valid([]byte(text)) {
		return []byte(text), nil
	}
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start != -1 && end > start && json.Valid([]byte(text[start:end+1])) {
		return []byte(text[start : end+1]), nil
	}
	return nil, errorf(http.StatusBadGateway, "The model did not return valid JSON.")
}

func httpError(status int, body []byte) *Error {
	detail := strings.Join(strings.Fields(string(bytes.ToValidUTF8(body, nil))), " ")
	if len(detail) > 400 {
		detail = detail[:400] + "…"
	}
	switch {
	case status == 401 || status == 403:
		return errorf(http.StatusUnauthorized, "Authentication failed (%d). Check your API key. %s", status, detail)
	case status == 429:
		return errorf(http.StatusTooManyRequests, "Rate limited by the provider (429). %s", detail)
	case status == 404:
		return errorf(http.StatusBadRequest, "Endpoint or model not found (404). Check base URL and model. %s", detail)
	default:
		return errorf(http.StatusBadGateway, "Provider returned HTTP %d. %s", status, detail)
	}
}
