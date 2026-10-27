package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/crypto/scrypt"
)

func hash(b []byte) []byte { h := sha256.Sum256(b); return h[:] }
func hx(b []byte) string   { return hex.EncodeToString(b) }
func random(n int) []byte {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func encode(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}
func aead(key []byte) (cipher.AEAD, error) {
	b, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(b)
}

type Sealed struct {
	Salt  []byte `json:"salt"`
	Nonce []byte `json:"nonce"`
	Data  []byte `json:"data"`
}

func seal(pass string, plain, aad []byte) ([]byte, error) {
	s := Sealed{Salt: random(32), Nonce: random(12)}
	key, e := scrypt.Key([]byte(pass), s.Salt, 32768, 8, 1, 32)
	if e != nil {
		return nil, e
	}
	defer clear(key)
	c, e := aead(key)
	if e != nil {
		return nil, e
	}
	s.Data = c.Seal(nil, s.Nonce, plain, aad)
	return json.Marshal(s)
}
func unseal(pass string, b, aad []byte) ([]byte, error) {
	var s Sealed
	if json.Unmarshal(b, &s) != nil || len(s.Salt) != 32 || len(s.Nonce) != 12 {
		return nil, errors.New("vault_format")
	}
	key, e := scrypt.Key([]byte(pass), s.Salt, 32768, 8, 1, 32)
	if e != nil {
		return nil, e
	}
	defer clear(key)
	c, e := aead(key)
	if e != nil {
		return nil, e
	}
	return c.Open(nil, s.Nonce, s.Data, aad)
}
func atomicFile(path string, b []byte) error {
	f, e := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(path + ".tmp")
		}
	}()
	if _, e = f.Write(b); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(path+".tmp", path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	e = d.Sync()
	ok = e == nil
	return e
}

type Envelope struct {
	Session string `json:"session"`
	From    string `json:"from"`
	To      string `json:"to"`
	Nonce   []byte `json:"nonce"`
	Data    []byte `json:"data"`
	Sig     []byte `json:"sig,omitempty"`
}

func (s *Server) transportKey(peer Peer, sid, from, to string) ([]byte, error) {
	raw, e := hex.DecodeString(peer.Encryption)
	if e != nil {
		return nil, e
	}
	pub, e := ecdh.X25519().NewPublicKey(raw)
	if e != nil {
		return nil, e
	}
	shared, e := s.enc.ECDH(pub)
	if e != nil {
		return nil, e
	}
	defer clear(shared)
	return hash(append(shared, []byte("dmw-tss-channel-v1|"+s.config.Network+"|"+sid+"|"+from+"|"+to)...)), nil
}
func (s *Server) wrap(peer Peer, sid string, w Wire) (Envelope, error) {
	e := Envelope{Session: sid, From: s.config.ID, To: peer.ID, Nonce: random(12)}
	key, err := s.transportKey(peer, sid, e.From, e.To)
	if err != nil {
		return e, err
	}
	defer clear(key)
	c, err := aead(key)
	if err != nil {
		return e, err
	}
	aad := encode(e)
	e.Data = c.Seal(nil, e.Nonce, encode(w), aad)
	e.Sig = ed25519.Sign(s.identity, encode(e))
	return e, nil
}
func (s *Server) unwrap(peer Peer, e Envelope) (Wire, error) {
	var w Wire
	sig := e.Sig
	e.Sig = nil
	pub, err := hex.DecodeString(peer.Identity)
	if err != nil || len(pub) != 32 || !ed25519.Verify(pub, encode(e), sig) {
		return w, errors.New("peer_auth")
	}
	key, err := s.transportKey(peer, e.Session, e.From, e.To)
	if err != nil {
		return w, err
	}
	defer clear(key)
	c, err := aead(key)
	if err != nil {
		return w, err
	}
	data := e.Data
	e.Data = nil
	if len(e.Nonce) != 12 {
		return w, errors.New("nonce")
	}
	b, err := c.Open(nil, e.Nonce, data, encode(e))
	if err != nil {
		return w, err
	}
	err = json.Unmarshal(b, &w)
	return w, err
}
