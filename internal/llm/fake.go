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

// fakeAnswer has the shape of a real tutor answer (headings, lists, bold, a
// quote) so the chat UI can be judged without a provider.
const fakeAnswer = `**（开发用假模型）** 这是演示回答，请在设置中配置真实的模型服务以获得讲解。

### 意思

这句话说的是：与其给自己定一个很大的目标，不如从**很小的行动**开始。

### 重点词汇

- **commit to doing sth.**：承诺、决心做某事（to 是介词，后接动名词）
- **put off**：拖延、推迟，比 *delay* 更口语
- **modest**：（目标）不大的、适度的

### 例句

> I've committed to walking for ten minutes every morning.

你的问题是：`

// StreamChat sends the answer in uneven bursts, like a real provider over a
// real network.
func (fakeClient) StreamChat(ctx context.Context, _ string, msgs []Message, onDelta func(string) error) error {
	last := ""
	if len(msgs) > 0 {
		last = msgs[len(msgs)-1].Content
	}
	reply := []rune(fakeAnswer + "“" + last + "”")
	sizes := []int{3, 9, 2, 14, 6, 1, 11, 5}
	delays := []time.Duration{20, 70, 15, 120, 35, 10, 90, 40}
	for i, k := 0, 0; i < len(reply); k++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delays[k%len(delays)] * time.Millisecond):
		}
		n := min(i+sizes[k%len(sizes)], len(reply))
		if err := onDelta(string(reply[i:n])); err != nil {
			return err
		}
		i = n
	}
	return nil
}
