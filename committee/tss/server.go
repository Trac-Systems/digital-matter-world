package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bnb-chain/tss-lib/v3/ecdsa/keygen"
)

type Config struct {
	ID        string `json:"id"`
	Network   string `json:"network"`
	Epoch     int    `json:"epoch"`
	Listen    string `json:"listen"`
	Directory string `json:"directory"`
	Secrets   string `json:"secrets"`
	Peers     []Peer `json:"peers"`
}
type Secrets struct {
	Token      string `json:"token"`
	Passphrase string `json:"passphrase"`
	Identity   string `json:"identity"`
	Encryption string `json:"encryption"`
}
type Pending struct {
	Start  Start                      `json:"start"`
	Save   *keygen.LocalPartySaveData `json:"save"`
	Public string                     `json:"public"`
	Ready  *Ready                     `json:"ready"`
}
type Vault struct {
	Decision  string                     `json:"decision"`
	SessionID string                     `json:"sessionId"`
	Network   string                     `json:"network"`
	Epoch     int                        `json:"epoch"`
	Retired   bool                       `json:"retired"`
	Peers     []Peer                     `json:"peers"`
	Public    string                     `json:"public"`
	Save      *keygen.LocalPartySaveData `json:"save"`
}
type Ready struct {
	ID         string `json:"id"`
	Commitment string `json:"commitment"`
	Signature  string `json:"signature"`
}
type Session struct {
	start     Start
	ctx       context.Context
	cancel    context.CancelFunc
	peers     map[string]Peer
	inbox     chan Wire
	messages  map[string]Wire
	echoes    map[string]map[string]string
	delivered map[string]bool
	running   bool
	status    string
	failure   string
	save      *keygen.LocalPartySaveData
	result    *Signature
	ready     *Ready
	public    string
}
type Server struct {
	mu       sync.Mutex
	config   Config
	secret   Secrets
	identity ed25519.PrivateKey
	enc      *ecdh.PrivateKey
	vault    *Vault
	session  *Session
	used     map[string]bool
	workers  sync.WaitGroup
	http     *http.Client
}

var hex32 = regexp.MustCompile(`^[0-9a-f]{64}$`)
var ident = regexp.MustCompile(`^[a-zA-Z0-9._:-]{1,96}$`)

func hasID(peers []Peer, id string) bool {
	for _, p := range peers {
		if p.ID == id {
			return true
		}
	}
	return false
}
func pubkey(save *keygen.LocalPartySaveData) string {
	if save == nil || save.ECDSAPub == nil {
		return ""
	}
	prefix := "02"
	if save.ECDSAPub.Y().Bit(0) == 1 {
		prefix = "03"
	}
	return prefix + fmt.Sprintf("%064x", save.ECDSAPub.X())
}
func readPrivate(path string) ([]byte, error) {
	st, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return nil, errors.New("private_file_mode")
	}
	return os.ReadFile(path)
}
func (s *Server) aad() []byte {
	return []byte("dmw-tss-vault-v1|" + s.config.Network + "|" + s.config.ID)
}
func (s *Server) persist(v *Vault) error {
	b, e := seal(s.secret.Passphrase, encode(v), s.aad())
	if e != nil {
		return e
	}
	return atomicFile(filepath.Join(s.config.Directory, "share.enc"), b)
}
func checkPeers(peers []Peer, n int) error {
	if len(peers) != n {
		return errors.New("committee_size")
	}
	seen := map[string]bool{}
	for _, p := range peers {
		if !ident.MatchString(p.ID) || !hex32.MatchString(p.Identity) || !hex32.MatchString(p.Encryption) {
			return errors.New("peer_identity")
		}
		u, e := url.Parse(p.URL)
		local := e == nil && u.Scheme == "http" && u.Hostname() == "127.0.0.1" && u.Port() != ""
		remote := e == nil && u.Scheme == "https" && net.ParseIP(u.Hostname()) == nil && strings.Contains(u.Hostname(), ".") && !strings.Contains(u.Hostname(), "localhost") && !strings.HasSuffix(u.Hostname(), ".local")
		if e != nil || (!local && !remote) || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("peer_loopback")
		}
		for _, k := range []string{"id:" + p.ID, "sig:" + p.Identity, "enc:" + p.Encryption, "url:" + p.URL} {
			if seen[k] {
				return errors.New("peer_duplicate")
			}
			seen[k] = true
		}
	}
	return nil
}
func (s *Server) prepare(st Start) error {
	if !hex32.MatchString(st.ID) || st.Network != s.config.Network || st.Epoch < 1 || st.Timeout < 1 || st.Timeout > 1800 {
		return errors.New("session_parameters")
	}
	if s.used[st.ID] {
		return errors.New("session_reused")
	}
	if s.session != nil && (s.session.status == "prepared" || s.session.status == "running" || s.session.status == "ready") {
		return errors.New("session_busy")
	}
	if st.Kind == "sign" {
		if len(st.NewPeers) != 0 || len(st.Peers) != 3 || !hex32.MatchString(st.Digest) || s.vault == nil || s.vault.Retired || st.Epoch != s.vault.Epoch {
			return errors.New("sign_state")
		}
		if e := checkPeers(st.Peers, 3); e != nil {
			return e
		}
		for _, p := range st.Peers {
			found := false
			for _, known := range s.vault.Peers {
				if p == known {
					found = true
				}
			}
			if !found {
				return errors.New("sign_membership")
			}
		}
	} else if st.Kind == "keygen" {
		if s.vault != nil || st.Epoch != max(1, s.config.Epoch) || len(st.NewPeers) != 0 || !bytes.Equal(encode(st.Peers), encode(s.config.Peers)) {
			return errors.New("keygen_state")
		}
		if e := checkPeers(st.Peers, 5); e != nil {
			return e
		}
	} else if st.Kind == "reshare" {
		if e := checkPeers(st.Peers, 5); e != nil {
			return e
		}
		if e := checkPeers(st.NewPeers, 5); e != nil {
			return e
		}
		if e := checkPeers(append(append([]Peer{}, st.Peers...), st.NewPeers...), 10); e != nil {
			return e
		}
		if hasID(st.Peers, s.config.ID) {
			if s.vault == nil || s.vault.Retired || st.Epoch != s.vault.Epoch+1 || !bytes.Equal(encode(st.Peers), encode(s.vault.Peers)) {
				return errors.New("reshare_state")
			}
		} else if s.vault != nil || !bytes.Equal(encode(st.NewPeers), encode(s.config.Peers)) {
			return errors.New("reshare_new_state")
		}
	} else {
		return errors.New("session_kind")
	}
	all := append(append([]Peer{}, st.Peers...), st.NewPeers...)
	peers := map[string]Peer{}
	for _, p := range all {
		peers[p.ID] = p
	}
	self, ok := peers[s.config.ID]
	if !ok || self.Identity != hx(s.identity.Public().(ed25519.PublicKey)) || self.Encryption != hx(s.enc.PublicKey().Bytes()) {
		return errors.New("session_identity")
	}
	f, e := os.OpenFile(filepath.Join(s.config.Directory, "sessions.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		return e
	}
	_, e = f.WriteString(st.ID + "\n")
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return e
	}
	s.used[st.ID] = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(st.Timeout)*time.Second)
	sess := &Session{start: st, ctx: ctx, cancel: cancel, peers: peers, inbox: make(chan Wire, 512), messages: map[string]Wire{}, echoes: map[string]map[string]string{}, delivered: map[string]bool{}, status: "prepared"}
	if s.session != nil {
		s.session.cancel()
	}
	s.session = sess
	go func() {
		<-ctx.Done()
		s.mu.Lock()
		defer s.mu.Unlock()
		if sess.status == "running" || sess.status == "prepared" || sess.status == "ready" {
			s.abort(sess, "session_expired")
		}
	}()
	return nil
}
func (s *Server) abort(sess *Session, reason string) {
	// A ready vote may already be in a commit certificate on another host.
	// Keep its encrypted prepared share until that decision is recovered.
	if sess.status == "ready" {
		return
	}
	sess.status = "aborted"
	sess.failure = reason
	sess.save = nil
	sess.result = nil
	sess.ready = nil
	sess.cancel()
}
func (s *Server) send(sess *Session, peer Peer, w Wire) {
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		env, e := s.wrap(peer, sess.start.ID, w)
		if e == nil {
			req, err := http.NewRequestWithContext(sess.ctx, "POST", peer.URL+"/peer", bytes.NewReader(encode(env)))
			if err != nil {
				e = err
			} else {
				req.Header.Set("Content-Type", "application/json")
				res, err := s.http.Do(req)
				if err != nil {
					e = err
				} else {
					io.Copy(io.Discard, io.LimitReader(res.Body, 1024))
					res.Body.Close()
					if res.StatusCode != 200 {
						e = errors.New("peer_refused")
					}
				}
			}
		}
		if e != nil {
			s.mu.Lock()
			defer s.mu.Unlock()
			if sess.status == "running" || sess.status == "prepared" {
				s.abort(sess, "transport_failed")
			}
		}
	}()
}
func (s *Server) fanout(sess *Session, w Wire) {
	for id, p := range sess.peers {
		if id != s.config.ID {
			s.send(sess, p, w)
		}
	}
}
func wireKey(w Wire) string { return w.From + "|" + w.Type }
func (s *Server) deliver(sess *Session, key string) error {
	if sess.delivered[key] {
		return nil
	}
	w, ok := sess.messages[key]
	if !ok {
		return nil
	}
	h := hx(hash(encode(w)))
	if w.Broadcast {
		for id := range sess.peers {
			v := sess.echoes[key][id]
			if v == "" {
				return nil
			}
			if v != h {
				return errors.New("broadcast_equivocation")
			}
		}
	}
	sess.delivered[key] = true
	if w.From != s.config.ID {
		for _, id := range w.To {
			if id == s.config.ID {
				select {
				case sess.inbox <- w:
				default:
					return errors.New("inbox_full")
				}
				break
			}
		}
	}
	return nil
}
func (s *Server) accept(sess *Session, sender string, w Wire) error {
	if len(sess.messages) > 512 || len(sess.echoes) > 512 {
		return errors.New("message_limit")
	}
	if w.Kind == "echo" {
		if !hex32.MatchString(w.Hash) || len(w.Key) > 200 {
			return errors.New("echo_format")
		}
		if sess.echoes[w.Key] == nil {
			sess.echoes[w.Key] = map[string]string{}
		}
		if old := sess.echoes[w.Key][sender]; old != "" && old != w.Hash {
			return errors.New("echo_equivocation")
		}
		sess.echoes[w.Key][sender] = w.Hash
		return s.deliver(sess, w.Key)
	}
	if w.Kind != "wire" || w.From != sender || len(w.Data) == 0 || len(w.Data) > 1<<20 || len(w.Type) > 160 || len(w.To) == 0 || len(w.To) > 10 {
		return errors.New("wire_format")
	}
	for _, id := range w.To {
		if _, ok := sess.peers[id]; !ok {
			return errors.New("wire_recipient")
		}
	}
	if !w.Broadcast && (len(w.To) != 1 || w.To[0] != s.config.ID) {
		return errors.New("unicast_recipient")
	}
	k := wireKey(w)
	h := hx(hash(encode(w)))
	if prev, ok := sess.messages[k]; ok {
		if hx(hash(encode(prev))) != h {
			return errors.New("wire_equivocation")
		}
		return nil
	}
	sess.messages[k] = w
	if w.Broadcast {
		if sess.echoes[k] == nil {
			sess.echoes[k] = map[string]string{}
		}
		sess.echoes[k][s.config.ID] = h
		s.fanout(sess, Wire{Kind: "echo", Key: k, Hash: h})
	}
	return s.deliver(sess, k)
}
func (s *Server) run(sess *Session) error {
	if sess.status != "prepared" {
		return errors.New("not_prepared")
	}
	sess.status = "running"
	sess.running = true
	exe, e := os.Executable()
	if e != nil {
		return e
	}
	cmd := exec.CommandContext(sess.ctx, exe, "worker")
	stdin, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	cmd.Stderr = io.Discard
	if e = cmd.Start(); e != nil {
		return e
	}
	input := WorkerInput{Start: sess.start, Self: s.config.ID}
	if s.vault != nil {
		input.Save = s.vault.Save
	}
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer stdin.Close()
		enc := json.NewEncoder(stdin)
		if enc.Encode(input) != nil {
			return
		}
		for {
			select {
			case w := <-sess.inbox:
				if enc.Encode(w) != nil {
					return
				}
			case <-sess.ctx.Done():
				return
			}
		}
	}()
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		scan := bufio.NewScanner(stdout)
		scan.Buffer(make([]byte, 4096), 4<<20)
		for scan.Scan() {
			var out WorkerOutput
			if json.Unmarshal(scan.Bytes(), &out) != nil {
				s.mu.Lock()
				s.abort(sess, "worker_output")
				s.mu.Unlock()
				break
			}
			s.mu.Lock()
			if sess.status != "running" {
				s.mu.Unlock()
				break
			}
			if out.Error != "" {
				s.abort(sess, out.Error)
			} else if out.Wire != nil {
				w := *out.Wire
				if w.Broadcast {
					if e := s.accept(sess, s.config.ID, w); e != nil {
						s.abort(sess, "broadcast_failed")
					} else {
						s.fanout(sess, w)
					}
				} else {
					for _, id := range w.To {
						p, ok := sess.peers[id]
						if !ok {
							s.abort(sess, "worker_recipient")
							break
						}
						s.send(sess, p, w)
					}
				}
			} else if out.Done {
				if sess.start.Kind == "sign" {
					if out.Signature == nil {
						s.abort(sess, "signature_missing")
					} else {
						sealed, err := seal(s.secret.Passphrase, encode(map[string]any{"start": sess.start, "signature": out.Signature}), append(s.aad(), []byte("|result|"+sess.start.ID)...))
						if err == nil {
							err = atomicFile(filepath.Join(s.config.Directory, "result-"+sess.start.ID+".enc"), sealed)
						}
						if err != nil {
							s.abort(sess, "result_persist")
						} else {
							sess.result = out.Signature
							sess.status = "complete"
						}
					}
				} else {
					sess.save = out.Save
					sess.public = pubkey(out.Save)
					if sess.start.Kind == "reshare" && hasID(sess.start.Peers, s.config.ID) {
						sess.public = s.vault.Public
						sess.save = nil
					}
					if sess.public == "" {
						s.abort(sess, "public_key_missing")
					} else if s.vault != nil && s.vault.Public != sess.public {
						s.abort(sess, "public_key_changed")
					} else {
						commitment := hx(hash(append(encode(sess.start), []byte("|"+sess.public)...)))
						sess.ready = &Ready{ID: s.config.ID, Commitment: commitment, Signature: hx(ed25519.Sign(s.identity, []byte("dmw-tss-ready-v1|"+commitment)))}
						pending := Pending{Start: sess.start, Save: sess.save, Public: sess.public, Ready: sess.ready}
						sealed, err := seal(s.secret.Passphrase, encode(pending), append(s.aad(), []byte("|pending")...))
						if err == nil {
							err = atomicFile(filepath.Join(s.config.Directory, "pending.enc"), sealed)
						}
						if err != nil {
							s.abort(sess, "pending_persist")
						} else {
							sess.status = "ready"
						}
					}
				}
			}
			s.mu.Unlock()
		}
		err := cmd.Wait()
		s.mu.Lock()
		defer s.mu.Unlock()
		sess.running = false
		if sess.status == "running" {
			if err != nil {
				s.abort(sess, "worker_failed")
			} else {
				s.abort(sess, "worker_incomplete")
			}
		}
	}()
	return nil
}
func (s *Server) commit(cert []Ready) error {
	decision := hx(hash(encode(cert)))
	if s.vault != nil && s.vault.Decision == decision {
		if s.session != nil && s.session.start.ID == s.vault.SessionID {
			if err := os.Remove(filepath.Join(s.config.Directory, "pending.enc")); err != nil && !os.IsNotExist(err) {
				return err
			}
			s.session.save = nil
			s.session.status = "committed"
			s.session.cancel()
		}
		return nil
	}
	sess := s.session
	if sess == nil || sess.status != "ready" {
		return errors.New("not_ready")
	}
	if len(cert) != len(sess.peers) {
		return errors.New("certificate_size")
	}
	seen := map[string]bool{}
	for _, r := range cert {
		p, ok := sess.peers[r.ID]
		raw, e := hex.DecodeString(r.Signature)
		pub, _ := hex.DecodeString(p.Identity)
		if !ok || seen[r.ID] || r.Commitment != sess.ready.Commitment || e != nil || !ed25519.Verify(pub, []byte("dmw-tss-ready-v1|"+r.Commitment), raw) {
			return errors.New("certificate_invalid")
		}
		seen[r.ID] = true
	}
	peers := sess.start.Peers
	retired := false
	if sess.start.Kind == "reshare" {
		peers = sess.start.NewPeers
		retired = hasID(sess.start.Peers, s.config.ID)
	}
	v := &Vault{Decision: decision, SessionID: sess.start.ID, Network: s.config.Network, Epoch: sess.start.Epoch, Peers: peers, Retired: retired, Public: sess.public, Save: sess.save}
	if e := s.persist(v); e != nil {
		return e
	}
	s.vault = v
	if err := os.Remove(filepath.Join(s.config.Directory, "pending.enc")); err != nil && !os.IsNotExist(err) {
		return err
	}
	sess.save = nil
	sess.status = "committed"
	sess.cancel()
	return nil
}
func (s *Server) handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	fail := func(status int, reason string) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
	}
	if r.Method != "POST" {
		fail(405, "post_required")
		return
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if e != nil {
		fail(413, "body_limit")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.URL.Path == "/peer" {
		var env Envelope
		if json.Unmarshal(body, &env) != nil {
			fail(400, "envelope_format")
			return
		}
		sess := s.session
		if sess == nil || env.Session != sess.start.ID || env.To != s.config.ID || (sess.status != "running" && sess.status != "prepared" && sess.status != "ready" && sess.status != "complete") {
			fail(409, "session_inactive")
			return
		}
		peer, ok := sess.peers[env.From]
		if !ok {
			fail(403, "peer_unknown")
			return
		}
		wire, e := s.unwrap(peer, env)
		if e != nil {
			fail(403, "peer_auth")
			return
		}
		if e = s.accept(sess, env.From, wire); e != nil {
			s.abort(sess, e.Error())
			fail(400, "message_rejected")
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.secret.Token)) != 1 {
		fail(403, "authentication")
		return
	}
	var result any = map[string]bool{"ok": true}
	switch r.URL.Path {
	case "/prepare":
		var st Start
		if json.Unmarshal(body, &st) != nil {
			e = errors.New("start_format")
		} else {
			e = s.prepare(st)
		}
	case "/go":
		if s.session == nil {
			e = errors.New("session_missing")
		} else {
			e = s.run(s.session)
		}
	case "/abort":
		if s.session != nil {
			s.abort(s.session, "operator_abort")
		}
	case "/commit":
		var cert []Ready
		if json.Unmarshal(body, &cert) != nil {
			e = errors.New("certificate_format")
		} else {
			e = s.commit(cert)
		}
	case "/result":
		var request struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(body, &request) != nil || !hex32.MatchString(request.ID) {
			e = errors.New("result_id")
		} else {
			var data, cleartext []byte
			data, e = readPrivate(filepath.Join(s.config.Directory, "result-"+request.ID+".enc"))
			if e == nil {
				cleartext, e = unseal(s.secret.Passphrase, data, append(s.aad(), []byte("|result|"+request.ID)...))
			}
			if e == nil {
				e = json.Unmarshal(cleartext, &result)
			}
		}
	case "/status":
		result = map[string]any{"id": s.config.ID, "epoch": 0, "public": nil, "retired": false}
		m := result.(map[string]any)
		if s.vault != nil {
			m["epoch"] = s.vault.Epoch
			m["public"] = s.vault.Public
			m["retired"] = s.vault.Retired
		}
		if s.session != nil {
			q := s.session
			m["session"] = map[string]any{"id": q.start.ID, "status": q.status, "error": q.failure, "signature": q.result, "ready": q.ready, "public": q.public}
		}
	case "/attest-bootstrap":
		var request struct {
			Challenge string `json:"challenge"`
		}
		if json.Unmarshal(body, &request) != nil || !hex32.MatchString(request.Challenge) || s.vault == nil || s.vault.Retired {
			e = errors.New("bootstrap_attestation")
		} else {
			roster := make([]map[string]string, 0, len(s.config.Peers))
			for _, peer := range s.config.Peers {
				roster = append(roster, map[string]string{"id": peer.ID, "identity": peer.Identity, "encryption": peer.Encryption})
			}
			rosterBytes, _ := json.Marshal(roster)
			digest := sha256.Sum256(rosterBytes)
			answer := map[string]any{"domain": "dmw-bootstrap-attestation-v1", "challenge": request.Challenge, "network": s.config.Network,
				"epoch": s.vault.Epoch, "id": s.config.ID, "publicKey": s.vault.Public, "roster": hx(digest[:])}
			encoded, _ := json.Marshal(answer)
			answer["signature"] = hx(ed25519.Sign(s.identity, encoded))
			result = answer
		}
	default:
		fail(404, "route")
		return
	}
	if e != nil {
		fail(409, e.Error())
		return
	}
	_ = json.NewEncoder(w).Encode(result)
}
func serve(path string) error {
	var c Config
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return e
	}
	host, _, e := net.SplitHostPort(c.Listen)
	if e != nil || host != "127.0.0.1" || !ident.MatchString(c.Network) || !ident.MatchString(c.ID) || !filepath.IsAbs(c.Directory) {
		return errors.New("local_configuration")
	}
	b, e = readPrivate(c.Secrets)
	if e != nil {
		return e
	}
	var secrets Secrets
	if json.Unmarshal(b, &secrets) != nil || len(secrets.Passphrase) < 32 || len(secrets.Token) < 32 {
		return errors.New("credentials")
	}
	seed, e := hex.DecodeString(secrets.Identity)
	if e != nil || len(seed) != 32 {
		return errors.New("identity")
	}
	encRaw, e := hex.DecodeString(secrets.Encryption)
	if e != nil {
		return e
	}
	enc, e := ecdh.X25519().NewPrivateKey(encRaw)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(c.Directory, 0700); e != nil {
		return e
	}
	s := &Server{config: c, secret: secrets, identity: ed25519.NewKeyFromSeed(seed), enc: enc, used: map[string]bool{}, http: &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, MaxIdleConns: 64, MaxConnsPerHost: 16}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect") }}}
	b, e = readPrivate(filepath.Join(c.Directory, "share.enc"))
	if e == nil {
		plain, err := unseal(secrets.Passphrase, b, s.aad())
		if err != nil {
			return errors.New("vault_decrypt")
		}
		defer clear(plain)
		var v Vault
		if json.Unmarshal(plain, &v) != nil || v.Network != c.Network {
			return errors.New("vault_invalid")
		}
		s.vault = &v
	} else if !os.IsNotExist(e) {
		return e
	}
	b, e = readPrivate(filepath.Join(c.Directory, "pending.enc"))
	if e == nil {
		plain, err := unseal(secrets.Passphrase, b, append(s.aad(), []byte("|pending")...))
		if err != nil {
			return errors.New("pending_decrypt")
		}
		defer clear(plain)
		var p Pending
		if json.Unmarshal(plain, &p) != nil || p.Start.Network != c.Network || p.Ready == nil || p.Ready.ID != c.ID {
			return errors.New("pending_invalid")
		}
		ctx, cancel := context.WithCancel(context.Background())
		peers := map[string]Peer{}
		for _, peer := range append(append([]Peer{}, p.Start.Peers...), p.Start.NewPeers...) {
			peers[peer.ID] = peer
		}
		s.session = &Session{start: p.Start, ctx: ctx, cancel: cancel, peers: peers, save: p.Save, public: p.Public, ready: p.Ready, status: "ready"}
	} else if !os.IsNotExist(e) {
		return e
	}
	b, e = readPrivate(filepath.Join(c.Directory, "sessions.log"))
	if e == nil {
		for _, id := range strings.Split(string(b), "\n") {
			if id != "" {
				if !hex32.MatchString(id) {
					return errors.New("session_log_corrupt")
				}
				s.used[id] = true
			}
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	server := &http.Server{Addr: c.Listen, Handler: http.HandlerFunc(s.handler), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		s.mu.Lock()
		if s.session != nil {
			s.abort(s.session, "shutdown")
		}
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()
	e = server.ListenAndServe()
	s.workers.Wait()
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "worker" {
		worker()
		return
	}
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: dmw-tss CONFIG")
		os.Exit(2)
	}
	if e := serve(os.Args[1]); e != nil {
		fmt.Fprintln(os.Stderr, "sidecar startup failed:", e)
		os.Exit(1)
	}
}
