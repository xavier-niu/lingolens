package levels

import "testing"

func TestKnows(t *testing.T) {
	tests := []struct {
		level string
		known []string
		not   []string
	}{
		{"A1", []string{"the", "people", "school"}, []string{"government", "environment", "ubiquitous"}},
		{"B1", []string{"people", "simple", "environment", "password"}, []string{"substantial", "ubiquitous"}},
		{"B2", []string{"simple", "substantial", "assess"}, []string{"ubiquitous", "mitigate"}},
		{"C1", []string{"people", "table", "simple", "really", "substantial", "inevitable", "scrutiny", "offline"},
			[]string{"perfunctory", "obsequious", "tensile"}},
		{"C2", []string{"people", "scrutiny", "ubiquitous", "mitigate", "nuance"}, []string{"obsequious"}},
	}
	for _, tt := range tests {
		lv := Get(tt.level)
		for _, w := range tt.known {
			if !lv.Knows(w) {
				t.Errorf("%s should know %q", tt.level, w)
			}
		}
		for _, w := range tt.not {
			if lv.Knows(w) {
				t.Errorf("%s shouldn't count %q as known", tt.level, w)
			}
		}
	}
}

func TestKnowsIgnoresCaseAndSpace(t *testing.T) {
	if !Get("C1").Knows(" People ") {
		t.Fatal("case or space changed the answer")
	}
	if Get("C2").Knows("zzzqqq") {
		t.Fatal("a made-up word is not known")
	}
}

// The file holds every level, and no word is listed under an unknown one.
func TestWordsFile(t *testing.T) {
	counts := map[int]int{}
	for w, at := range knownFrom {
		if at < 0 {
			t.Fatalf("%q is under a level that doesn't exist", w)
		}
		counts[at]++
	}
	for i, lv := range All {
		if counts[i] == 0 {
			t.Errorf("no words for %s", lv.ID)
		}
	}
}
