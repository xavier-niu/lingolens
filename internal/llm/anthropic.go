package llm

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go/v2"
	"github.com/anthropics/anthropic-sdk-go/v2/option"
)

const DefaultAnthropicModel = "claude-opus-5-5"

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
var fallbackModels = map[string]bool{
	"claude-fable-5-1": true, "claude-opus-5-5": true, "claude-opus-5": true, "claude-sonnet-5-5": true,
}

// Models that accept output_config.effort.
var effortModelRe = regexp.MustCompile(`^claude-(fable-5|mythos-5|opus-5|sonnet-5|haiku-5-5|opus-4-[5678]|sonnet-4-6)`)

type anthropicClient struct {
	cfg    Config
	model  string
	client anthropic.Client
}

func newAnthropic(cfg Config) *anthropicClient {
	opts := []option.RequestOption{
		option.WithAPIKey(cfg.APIKey),
		option.WithMaxRetries(2),
		option.WithRequestTimeout(5 * time.Minute),
	}
	if cfg.BaseURL != "" {
		opts = append(opts, option.WithBaseURL(cfg.BaseURL))
	}
	model := cfg.Model
	if model == "" {
		model = DefaultAnthropicModel
	}
	return &anthropicClient{cfg: cfg, model: model, client: anthropic.NewClient(opts...)}
}

func (c *anthropicClient) official() bool {
	return c.cfg.BaseURL == "" || strings.Contains(c.cfg.BaseURL, "api.anthropic.com")
}

// requestOptions opts into the server-side refusal fallback where supported: on a
// safety decline, the API re-runs the request on a suitable fallback model.
func (c *anthropicClient) requestOptions() []option.RequestOption {
	if c.official() && fallbackModels[c.model] {
		return []option.RequestOption{
			option.WithHeader("anthropic-beta", "server-side-fallback-2026-07-01"),
			option.WithJSONSet("fallbacks", "default"),
		}
	}
	return nil
}

func (c *anthropicClient) effort(e anthropic.OutputConfigEffort) anthropic.OutputConfigEffort {
	if effortModelRe.MatchString(c.model) {
		return e
	}
	return ""
}

func (c *anthropicClient) CompleteJSON(ctx context.Context, system, user string, schema map[string]any) ([]byte, error) {
	params := anthropic.MessageNewParams{
		Model:     c.model,
		MaxTokens: 16000,
		System:    []anthropic.TextBlockParam{{Text: system}},
		Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(user))},
		OutputConfig: anthropic.OutputConfigParam{
			Effort: c.effort(anthropic.OutputConfigEffortLow),
			Format: anthropic.JSONOutputFormatParam{Schema: schema},
		},
	}
	resp, err := c.client.Messages.New(ctx, params, c.requestOptions()...)
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusBadRequest &&
		(strings.Contains(err.Error(), "format") || strings.Contains(err.Error(), "output_config")) {
		// Older models and Anthropic-compatible gateways may lack structured outputs;
		// the prompt itself still asks for JSON.
		params.OutputConfig.Format = anthropic.JSONOutputFormatParam{}
		resp, err = c.client.Messages.New(ctx, params, c.requestOptions()...)
	}
	if err != nil {
		return nil, anthropicError(ctx, err)
	}
	if resp.StopReason == anthropic.StopReasonRefusal {
		return nil, errorf(http.StatusUnprocessableEntity, "The model declined to process this text.")
	}
	var last string
	for _, block := range resp.Content {
		if tb, ok := block.AsAny().(anthropic.TextBlock); ok {
			last = tb.Text
		}
	}
	if last == "" {
		return nil, errorf(http.StatusBadGateway, "The model returned no text.")
	}
	return ExtractJSON(last)
}

func (c *anthropicClient) StreamChat(ctx context.Context, system string, msgs []Message, onDelta func(string) error) error {
	history := make([]anthropic.MessageParam, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "assistant" {
			history = append(history, anthropic.NewAssistantMessage(anthropic.NewTextBlock(m.Content)))
		} else {
			history = append(history, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Content)))
		}
	}
	stream := c.client.Messages.NewStreaming(ctx, anthropic.MessageNewParams{
		Model:        c.model,
		MaxTokens:    16000,
		System:       []anthropic.TextBlockParam{{Text: system}},
		Messages:     history,
		OutputConfig: anthropic.OutputConfigParam{Effort: c.effort(anthropic.OutputConfigEffortMedium)},
	}, c.requestOptions()...)
	defer stream.Close()

	message := anthropic.Message{}
	for stream.Next() {
		event := stream.Current()
		_ = message.Accumulate(event)
		if delta, ok := event.AsAny().(anthropic.ContentBlockDeltaEvent); ok {
			if td, ok := delta.Delta.AsAny().(anthropic.TextDelta); ok && td.Text != "" {
				if err := onDelta(td.Text); err != nil {
					return err
				}
			}
		}
	}
	if err := stream.Err(); err != nil {
		return anthropicError(ctx, err)
	}
	switch message.StopReason {
	case anthropic.StopReasonRefusal:
		return onDelta("\n\n_（模型拒绝继续回答此问题。）_")
	case anthropic.StopReasonMaxTokens:
		return onDelta("\n\n_（回答已达到长度上限被截断。）_")
	}
	return nil
}

func anthropicError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		switch apiErr.StatusCode {
		case 401, 403:
			return errorf(http.StatusUnauthorized, "Anthropic rejected the API key (%d).", apiErr.StatusCode)
		case 404:
			return errorf(http.StatusBadRequest, "Model or endpoint not found. Check the model name and base URL.")
		case 429:
			return errorf(http.StatusTooManyRequests, "Rate limited by Anthropic. Try again shortly.")
		default:
			msg := err.Error()
			if len(msg) > 400 {
				msg = msg[:400] + "…"
			}
			return errorf(http.StatusBadGateway, "Anthropic error %d: %s", apiErr.StatusCode, msg)
		}
	}
	return errorf(http.StatusBadGateway, "Could not reach the Anthropic API.")
}
