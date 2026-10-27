package main

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
)

func TestCommitRecoveryAfterVaultPersist(t *testing.T) {
	dir := t.TempDir()
	cert := []Ready{{ID: "fixture", Commitment: "public-decision", Signature: "already-verified-before-persist"}}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{config: Config{Directory: dir}, vault: &Vault{Decision: hx(hash(encode(cert))), SessionID: "committed-session"}, session: &Session{start: Start{ID: "committed-session"}, status: "ready", ctx: ctx, cancel: cancel}}
	path := filepath.Join(dir, "pending.enc")
	if err := os.WriteFile(path, []byte("encrypted-prepared-share"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(cert); err != nil {
		t.Fatal(err)
	}
	if s.session.status != "committed" {
		t.Fatal("stale ready state blocks the next ceremony")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("stale prepared share retained")
	}
	// Replaying an older decision must never clear the next ceremony's share.
	s.session.start.ID = "next-session"
	s.session.status = "ready"
	if err := os.WriteFile(path, []byte("next-encrypted-share"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.commit(cert); err != nil {
		t.Fatal(err)
	}
	if s.session.status != "ready" {
		t.Fatal("old replay changed next ceremony")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}

func TestEncryptedVault(t *testing.T) {
	pass := "local-disposable-passphrase-32-bytes"
	plain := []byte(`{"Xi":"local-test-share"}`)
	aad := []byte("network|signer")
	box, e := seal(pass, plain, aad)
	if e != nil {
		t.Fatal(e)
	}
	got, e := unseal(pass, box, aad)
	if e != nil || string(got) != string(plain) {
		t.Fatal("roundtrip")
	}
	if _, e = unseal("incorrect", box, aad); e == nil {
		t.Fatal("wrong passphrase")
	}
	if _, e = unseal(pass, box, []byte("other")); e == nil {
		t.Fatal("wrong context")
	}
	path := filepath.Join(t.TempDir(), "share.enc")
	if e = atomicFile(path, box); e != nil {
		t.Fatal(e)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0600 {
		t.Fatal("mode")
	}
}
func TestPeerEncryptionAndAuthentication(t *testing.T) {
	makeServer := func(id string) (*Server, Peer) {
		pub, private, _ := ed25519.GenerateKey(rand.Reader)
		enc, _ := ecdh.X25519().GenerateKey(rand.Reader)
		return &Server{config: Config{ID: id, Network: "local"}, identity: private, enc: enc}, Peer{ID: id, Identity: hx(pub), Encryption: hx(enc.PublicKey().Bytes())}
	}
	a, pa := makeServer("a")
	b, pb := makeServer("b")
	w := Wire{Kind: "wire", From: "a", To: []string{"b"}, Type: "test", Data: []byte("private-share")}
	box, e := a.wrap(pb, "session", w)
	if e != nil {
		t.Fatal(e)
	}
	got, e := b.unwrap(pa, box)
	if e != nil || string(got.Data) != string(w.Data) {
		t.Fatal("channel")
	}
	box.Data[0] ^= 1
	if _, e = b.unwrap(pa, box); e == nil {
		t.Fatal("tampering")
	}
	box.Data[0] ^= 1
	box.Session = "other"
	if _, e = b.unwrap(pa, box); e == nil {
		t.Fatal("session replay")
	}
}
func TestBroadcastEquivocation(t *testing.T) {
	s := &Server{config: Config{ID: "a"}}
	q := &Session{peers: map[string]Peer{"a": {ID: "a"}, "b": {ID: "b"}, "c": {ID: "c"}}, messages: map[string]Wire{}, echoes: map[string]map[string]string{}, delivered: map[string]bool{}, inbox: make(chan Wire, 1)}
	w := Wire{Kind: "wire", From: "b", Type: "test", Broadcast: true, To: []string{"a"}, Data: []byte{1}}
	k := wireKey(w)
	q.messages[k] = w
	h := hx(hash(encode(w)))
	q.echoes[k] = map[string]string{"a": h, "b": h}
	if e := s.deliver(q, k); e != nil || len(q.inbox) != 0 {
		t.Fatal("delivered before reliable broadcast")
	}
	q.echoes[k]["c"] = "different"
	if e := s.deliver(q, k); e == nil {
		t.Fatal("equivocation accepted")
	}
	q.echoes[k]["c"] = h
	if e := s.deliver(q, k); e != nil || len(q.inbox) != 1 {
		t.Fatal("delivery")
	}
	if e := s.deliver(q, k); e != nil || len(q.inbox) != 1 {
		t.Fatal("duplicate delivery")
	}
}
func TestRosterAndLoopback(t *testing.T) {
	if checkPeers([]Peer{{ID: "a", URL: "http://192.0.2.1:1234", Identity: hx(make([]byte, 32)), Encryption: hx(make([]byte, 32))}}, 1) == nil {
		t.Fatal("nonloopback")
	}
	p := Peer{ID: "a", URL: "http://127.0.0.1:1234", Identity: hx(make([]byte, 32)), Encryption: hx(make([]byte, 32))}
	if checkPeers([]Peer{p, p}, 2) == nil {
		t.Fatal("duplicate")
	}
}
