package llm

import (
	"context"
	"errors"
	"time"
)

// fakeClient is an offline stand-in for UI development (LINGOLENS_DEV_FAKE=1).
// Annotation faking lives in the annotate package; this only fakes chat.
type fakeClient struct{}

func (fakeClient) CompleteJSON(context.Context, string, string, map[string]any) ([]byte, error) {
	return nil, errors.New("fake client does not implement CompleteJSON")
}

func (fakeClient) StreamChat(ctx context.Context, _ string, msgs []Message, onDelta func(string) error) error {
	last := ""
	if len(msgs) > 0 {
		last = msgs[len(msgs)-1].Content
	}
	reply := []rune("**（开发用假模型）** 你的问题是：\n\n> " + last + "\n\n请在设置中配置真实的模型服务以获得讲解。")
	for i := 0; i < len(reply); i += 8 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(15 * time.Millisecond):
		}
		if err := onDelta(string(reply[i:min(i+8, len(reply))])); err != nil {
			return err
		}
	}
	return nil
}
