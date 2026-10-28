package main

import (
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
)

// Epoch retains the original JSON representation in signed legacy ceremony
// commitments. New decimal epochs have no machine-word bound. Bare JSON
// numbers are accepted only within JavaScript's exact legacy range.
type Epoch string

var epochDecimal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func (e Epoch) decimal() string {
	if e == "" {
		return "0"
	}
	s := string(e)
	if s[0] == '"' {
		return s[1 : len(s)-1]
	}
	return s
}
func (e *Epoch) UnmarshalJSON(raw []byte) error {
	s := string(raw)
	quoted := len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"'
	d := s
	if quoted {
		d = s[1 : len(s)-1]
	}
	if !epochDecimal.MatchString(d) {
		return errors.New("epoch_decimal")
	}
	n, _ := new(big.Int).SetString(d, 10)
	if !quoted && n.Cmp(big.NewInt(9007199254740991)) > 0 {
		return errors.New("epoch_legacy_precision")
	}
	*e = Epoch(s)
	return nil
}
func (e Epoch) MarshalJSON() ([]byte, error) {
	if e == "" {
		return []byte("0"), nil
	}
	var checked Epoch
	if err := checked.UnmarshalJSON([]byte(e)); err != nil {
		return nil, err
	}
	return []byte(e), nil
}
func (e Epoch) positive() bool         { return e.decimal() != "0" }
func (e Epoch) equal(other Epoch) bool { return e.decimal() == other.decimal() }
func (e Epoch) next() Epoch {
	n, _ := new(big.Int).SetString(e.decimal(), 10)
	n.Add(n, big.NewInt(1))
	if len(e) > 0 && e[0] == '"' || n.Cmp(big.NewInt(9007199254740991)) > 0 {
		encoded, _ := json.Marshal(n.String())
		return Epoch(encoded)
	}
	return Epoch(n.String())
}
func (e Epoch) initial() Epoch {
	if e.positive() {
		return e
	}
	return Epoch("1")
}
