package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestExtractJSON(t *testing.T) {
	for _, in := range []string{
		`{"a":1}`,
		"```json\n{\"a\":1}\n```",
		"Sure! Here you go:\n{\"a\":1}\nHope that helps.",
	} {
		out, err := ExtractJSON(in)
		if err != nil || string(out) != `{"a":1}` {
			t.Errorf("ExtractJSON(%q) = %q, %v", in, out, err)
		}
	}
	if _, err := ExtractJSON("no json here"); err == nil {
		t.Error("expected error")
	}
}

func TestNewValidation(t *testing.T) {
	if _, err := New(Config{Kind: "anthropic"}, false, nil); err == nil {
		t.Error("anthropic without key should fail")
	}
	if _, err := New(Config{Kind: "openai"}, false, nil); err == nil {
		t.Error("openai without model should fail")
	}
	if _, err := New(Config{Kind: "fake"}, false, nil); err == nil {
		t.Error("fake must be disabled unless allowed")
	}
}

func TestOpenAICompleteJSONFallsBackWithoutJSONMode(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("bad request: %s %q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if _, ok := body["response_format"]; ok {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":{"message":"response_format is not supported"}}`)
			return
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"`+"```json\\n{\\\"segments\\\":[]}\\n```"+`"}}]}`)
	}))
	defer srv.Close()

	c, err := New(Config{Kind: "openai", BaseURL: srv.URL + "/v1/", APIKey: "sk-test", Model: "m"}, false, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.CompleteJSON(context.Background(), "sys", "user", nil)
	if err != nil || string(out) != `{"segments":[]}` || calls != 2 {
		t.Fatalf("out=%s err=%v calls=%d", out, err, calls)
	}
}

func TestOpenAIErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"error":"invalid key"}`)
	}))
	defer srv.Close()
	c, _ := New(Config{Kind: "openai", BaseURL: srv.URL, Model: "m"}, false, srv.Client())
	_, err := c.CompleteJSON(context.Background(), "s", "u", nil)
	var le *Error
	if !errors.As(err, &le) || le.Status != 401 {
		t.Fatalf("want 401 llm.Error, got %v", err)
	}
}

func TestOpenAIStreamChat(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Stream   bool      `json:"stream"`
			Messages []Message `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !body.Stream || len(body.Messages) != 2 || body.Messages[0].Role != "system" {
			t.Errorf("bad body: %+v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, part := range []string{"你好", "，", "world"} {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", part)
		}
		fmt.Fprint(w, ": keep-alive\n\ndata: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	c, _ := New(Config{Kind: "openai", BaseURL: srv.URL, Model: "m"}, false, srv.Client())
	var sb strings.Builder
	err := c.StreamChat(context.Background(), "sys", []Message{{Role: "user", Content: "hi"}}, func(s string) error {
		sb.WriteString(s)
		return nil
	})
	if err != nil || sb.String() != "你好，world" {
		t.Fatalf("got %q, %v", sb.String(), err)
	}
}

func TestAnthropicRequestShape(t *testing.T) {
	var got map[string]any
	var beta string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		beta = r.Header.Get("anthropic-beta")
		if r.Header.Get("x-api-key") != "sk-ant-test" && r.Header.Get("Authorization") != "Bearer sk-ant-test" {
			t.Errorf("missing api key header")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5",
			"content":[{"type":"text","text":"{\"segments\":[]}"}],
			"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	defer srv.Close()

	c, err := New(Config{Kind: "anthropic", BaseURL: srv.URL, APIKey: "sk-ant-test"}, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	out, err := c.CompleteJSON(context.Background(), "sys", "user", map[string]any{"type": "object"})
	if err != nil || string(out) != `{"segments":[]}` {
		t.Fatalf("out=%s err=%v", out, err)
	}
	if got["model"] != DefaultAnthropicModel {
		t.Errorf("model = %v", got["model"])
	}
	oc, _ := got["output_config"].(map[string]any)
	if oc["effort"] != "low" || oc["format"] == nil {
		t.Errorf("output_config = %v", oc)
	}
	// Custom base URL (a gateway) must not receive Anthropic-only beta fields.
	if beta != "" || got["fallbacks"] != nil {
		t.Errorf("unexpected fallback opt-in on custom base URL: beta=%q fallbacks=%v", beta, got["fallbacks"])
	}
}
