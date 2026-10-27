package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"sync"

	"github.com/bnb-chain/tss-lib/v3/common"
	"github.com/bnb-chain/tss-lib/v3/ecdsa/keygen"
	"github.com/bnb-chain/tss-lib/v3/ecdsa/resharing"
	"github.com/bnb-chain/tss-lib/v3/ecdsa/signing"
	"github.com/bnb-chain/tss-lib/v3/tss"
)

type Peer struct {
	ID         string `json:"id"`
	URL        string `json:"url"`
	Identity   string `json:"identity"`
	Encryption string `json:"encryption"`
}
type Start struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Network  string `json:"network"`
	Epoch    int    `json:"epoch"`
	Digest   string `json:"digest"`
	Peers    []Peer `json:"peers"`
	NewPeers []Peer `json:"newPeers"`
	Timeout  int    `json:"timeout"`
}
type Wire struct {
	Kind      string   `json:"kind"`
	From      string   `json:"from"`
	To        []string `json:"to"`
	Type      string   `json:"type"`
	Broadcast bool     `json:"broadcast"`
	Data      []byte   `json:"data"`
	Key       string   `json:"key"`
	Hash      string   `json:"hash"`
}
type WorkerInput struct {
	Start Start                      `json:"start"`
	Self  string                     `json:"self"`
	Save  *keygen.LocalPartySaveData `json:"save"`
}
type WorkerOutput struct {
	Wire      *Wire                      `json:"wire,omitempty"`
	Save      *keygen.LocalPartySaveData `json:"save,omitempty"`
	Signature *Signature                 `json:"signature,omitempty"`
	Done      bool                       `json:"done,omitempty"`
	Error     string                     `json:"error,omitempty"`
}
type Signature struct {
	R       string `json:"r"`
	S       string `json:"s"`
	V       int    `json:"v"`
	Compact string `json:"compact"`
}

func partyIDs(peers []Peer) (tss.SortedPartyIDs, map[string]*tss.PartyID) {
	ids := make(tss.UnSortedPartyIDs, 0, len(peers))
	for _, p := range peers {
		h := hash([]byte("dmw-tss-party-v1|" + p.ID + "|" + p.Identity))
		ids = append(ids, tss.NewPartyID(p.ID, p.ID, new(big.Int).SetBytes(h)))
	}
	sorted := tss.SortPartyIDs(ids)
	byID := map[string]*tss.PartyID{}
	for _, id := range sorted {
		byID[id.Id] = id
	}
	return sorted, byID
}

// Each ceremony runs in a disposable process. Cancellation kills that process,
// including library computations which cannot otherwise be interrupted.
func worker() {
	var mu sync.Mutex
	emit := func(v WorkerOutput) { mu.Lock(); defer mu.Unlock(); _ = json.NewEncoder(os.Stdout).Encode(v) }
	defer func() {
		if recover() != nil {
			emit(WorkerOutput{Error: "protocol_panic"})
		}
	}()
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 4<<20)
	if !scan.Scan() {
		return
	}
	var input WorkerInput
	if json.Unmarshal(scan.Bytes(), &input) != nil {
		emit(WorkerOutput{Error: "worker_input"})
		return
	}
	st := input.Start
	old, oldMap := partyIDs(st.Peers)
	next, newMap := partyIDs(st.NewPeers)
	self := oldMap[input.Self]
	if self == nil {
		self = newMap[input.Self]
	}
	out := make(chan tss.Message)
	end := make(chan *keygen.LocalPartySaveData, 1)
	signed := make(chan *common.SignatureData, 1)
	errs := make(chan *tss.Error, 1)
	params := tss.NewParameters(tss.S256(), tss.NewPeerContext(old), self, len(old), 2)
	params.SetConcurrency(2)
	params.SetSessionNonce(new(big.Int).SetBytes(hash([]byte("dmw-tss-session-v1|" + st.Network + "|" + st.ID))))
	var party tss.Party
	switch st.Kind {
	case "keygen":
		party = keygen.NewLocalParty(params, out, end)
	case "sign":
		raw, _ := hex.DecodeString(st.Digest)
		party = signing.NewLocalParty(new(big.Int).SetBytes(raw), params, *input.Save, out, signed, len(raw))
	case "reshare":
		p := tss.NewReSharingParameters(tss.S256(), tss.NewPeerContext(old), tss.NewPeerContext(next), self, len(old), 2, len(next), 2)
		p.SetConcurrency(2)
		p.SetSessionNonce(params.SessionNonce())
		save := keygen.NewLocalPartySaveData(5)
		if input.Save != nil {
			save = *input.Save
		}
		party = resharing.NewLocalParty(p, save, out, end)
	default:
		emit(WorkerOutput{Error: "worker_kind"})
		return
	}
	go func() {
		if e := party.Start(); e != nil {
			errs <- e
		}
	}()
	go func() {
		defer func() {
			if recover() != nil {
				emit(WorkerOutput{Error: "protocol_panic"})
				os.Exit(1)
			}
		}()
		for scan.Scan() {
			var w Wire
			if json.Unmarshal(scan.Bytes(), &w) != nil {
				emit(WorkerOutput{Error: "wire_json"})
				os.Exit(1)
			}
			from := oldMap[w.From]
			if from == nil {
				from = newMap[w.From]
			}
			if from == nil {
				emit(WorkerOutput{Error: "wire_sender"})
				os.Exit(1)
			}
			msg, e := tss.ParseWireMessage(w.Data, from, w.Broadcast)
			if e != nil || msg.Type() != w.Type {
				emit(WorkerOutput{Error: "wire_type"})
				os.Exit(1)
			}
			if _, e := party.Update(msg); e != nil {
				errs <- e
				return
			}
		}
	}()
	for {
		select {
		case <-errs:
			emit(WorkerOutput{Error: "protocol_rejected"})
			return
		case msg := <-out:
			b, _, e := msg.WireBytes()
			if e != nil {
				emit(WorkerOutput{Error: "wire_encode"})
				return
			}
			to := []string{}
			if msg.GetTo() != nil {
				for _, p := range msg.GetTo() {
					to = append(to, p.Id)
				}
			} else {
				destinations := st.Peers
				if st.Kind == "reshare" {
					destinations = st.NewPeers
					if msg.IsToOldCommittee() {
						destinations = st.Peers
					}
					if msg.IsToOldAndNewCommittees() {
						destinations = append(append([]Peer{}, st.Peers...), st.NewPeers...)
					}
				}
				for _, p := range destinations {
					to = append(to, p.ID)
				}
			}
			emit(WorkerOutput{Wire: &Wire{Kind: "wire", From: input.Self, To: to, Type: msg.Type(), Broadcast: msg.IsBroadcast(), Data: b}})
		case save := <-end:
			emit(WorkerOutput{Save: save, Done: true})
			return
		case sig := <-signed:
			r := new(big.Int).SetBytes(sig.R)
			s := new(big.Int).SetBytes(sig.S)
			v := int(sig.SignatureRecovery[0])
			half := new(big.Int).Rsh(new(big.Int).Set(tss.S256().Params().N), 1)
			if s.Cmp(half) > 0 {
				s.Sub(tss.S256().Params().N, s)
				v ^= 1
			}
			if v > 1 {
				emit(WorkerOutput{Error: "recovery_overflow"})
				return
			}
			emit(WorkerOutput{Done: true, Signature: &Signature{R: r.String(), S: s.String(), V: v, Compact: fmt.Sprintf("%064x%064x", r, s)}})
			return
		}
	}
}
