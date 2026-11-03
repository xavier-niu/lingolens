package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const defaultOpenAIBase = "https://api.openai.com/v1"

// openAIClient speaks the OpenAI Chat Completions protocol, which OpenAI, DeepSeek,
// OpenRouter, LiteLLM, Qwen, Moonshot, Ollama and most gateways implement.
type openAIClient struct {
	cfg  Config
	http *http.Client
}

func (c *openAIClient) url() string {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	if base == "" {
		base = defaultOpenAIBase
	}
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func (c *openAIClient) post(ctx context.Context, body map[string]any) (*http.Response, error) {
	buf, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url(), bytes.NewReader(buf))
	if err != nil {
		return nil, errorf(http.StatusBadRequest, "Invalid base URL: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}
	if strings.Contains(c.cfg.BaseURL, "openrouter.ai") {
		req.Header.Set("X-Title", "LingoLens")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		var ue interface{ Timeout() bool }
		if errors.As(err, &ue) && ue.Timeout() {
			return nil, errorf(http.StatusGatewayTimeout, "The provider timed out.")
		}
		return nil, errorf(http.StatusBadGateway, "Could not reach the provider at %s.", c.url())
	}
	return resp, nil
}

func (c *openAIClient) CompleteJSON(ctx context.Context, system, user string, _ map[string]any) ([]byte, error) {
	body := map[string]any{
		"model": c.cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		"response_format": map[string]string{"type": "json_object"},
	}
	resp, err := c.post(ctx, body)
	if err != nil {
		return nil, err
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusBadRequest && bytes.Contains(raw, []byte("response_format")) {
		// Some compatible servers lack JSON mode; the prompt alone asks for JSON.
		delete(body, "response_format")
		if resp, err = c.post(ctx, body); err != nil {
			return nil, err
		}
		raw, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	if resp.StatusCode >= 400 {
		return nil, httpError(resp.StatusCode, raw)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || len(out.Choices) == 0 {
		return nil, errorf(http.StatusBadGateway, "Unexpected response from provider.")
	}
	return ExtractJSON(out.Choices[0].Message.Content)
}

func (c *openAIClient) StreamChat(ctx context.Context, system string, msgs []Message, onDelta func(string) error) error {
	messages := []Message{{Role: "system", Content: system}}
	messages = append(messages, msgs...)
	resp, err := c.post(ctx, map[string]any{"model": c.cfg.Model, "stream": true, "messages": messages})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return httpError(resp.StatusCode, raw)
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[5:])
		if data == "[DONE]" {
			return nil
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if chunk.Error != nil {
			return errorf(http.StatusBadGateway, "Provider error: %s", chunk.Error.Message)
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			if err := onDelta(chunk.Choices[0].Delta.Content); err != nil {
				return err
			}
		}
	}
	if err := sc.Err(); err != nil && ctx.Err() == nil {
		return errorf(http.StatusBadGateway, "Stream interrupted: %v", err)
	}
	return ctx.Err()
}
