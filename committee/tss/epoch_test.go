package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEpochEncodingAndSuccessor(t *testing.T) {
	for _, raw := range []string{"1", `"1"`, `"9007199254740991"`, `"9223372036854775807"`, `"` + strings.Repeat("9", 80) + `"`} {
		var epoch Epoch
		if err := json.Unmarshal([]byte(raw), &epoch); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(epoch)
		if err != nil || string(encoded) != raw {
			t.Fatalf("changed retained encoding: %s", encoded)
		}
		var restored Epoch
		if err := json.Unmarshal(encode(epoch.next()), &restored); err != nil || !restored.equal(epoch.next()) || restored.equal(epoch) {
			t.Fatal("successor/reopen")
		}
	}
	for _, raw := range []string{"9007199254740992", "-1", "1.0", "1e3", `"01"`, `"+1"`, `"\u0031"`, "null"} {
		var epoch Epoch
		if json.Unmarshal([]byte(raw), &epoch) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if Epoch("9007199254740991").next() != Epoch(`"9007199254740992"`) {
		t.Fatal("unsafe numeric successor")
	}
}

func TestSigningEpochChecksUseExactDecimals(t *testing.T) {
	base := Epoch(`"` + strings.Repeat("9", 80) + `"`)
	s := &Server{config: Config{Network: "fixture"}, vault: &Vault{Epoch: base}, used: map[string]bool{}}
	start := Start{ID: strings.Repeat("a", 64), Kind: "sign", Network: "fixture", Epoch: base.next(), Digest: strings.Repeat("b", 64), Timeout: 1, Peers: make([]Peer, 3)}
	if err := s.prepare(start); err == nil || err.Error() != "sign_state" {
		t.Fatalf("wrong epoch: %v", err)
	}
	start.Epoch = base
	if err := s.prepare(start); err == nil || err.Error() == "sign_state" {
		t.Fatalf("equal epoch should reach membership checks: %v", err)
	}
}
