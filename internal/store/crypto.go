package store

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
)

// sealer encrypts API keys at rest with AES-256-GCM. The user ID is bound in as
// additional data, so a sealed blob copied to another user's row won't open.
type sealer struct{ aead cipher.AEAD }

func newSealer(secret []byte) (*sealer, error) {
	if len(secret) != 32 {
		return nil, errors.New("secret must be 32 bytes")
	}
	block, err := aes.NewCipher(secret)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &sealer{aead}, nil
}

func (s *sealer) seal(plaintext []byte, userID int64) []byte {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return s.aead.Seal(nonce, nonce, plaintext, aad(userID))
}

func (s *sealer) open(sealed []byte, userID int64) ([]byte, error) {
	n := s.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed data too short")
	}
	return s.aead.Open(nil, sealed[:n], sealed[n:], aad(userID))
}

func aad(userID int64) []byte { return []byte(fmt.Sprintf("lingolens/api-keys/user:%d", userID)) }

// LoadSecret returns the encryption secret from LINGOLENS_SECRET (64 hex chars or
// base64 of 32 bytes) if set; otherwise it reads, or creates, a key file at path.
func LoadSecret(env, path string) ([]byte, error) {
	if env = strings.TrimSpace(env); env != "" {
		if b, err := hex.DecodeString(env); err == nil && len(b) == 32 {
			return b, nil
		}
		if b, err := base64.StdEncoding.DecodeString(env); err == nil && len(b) == 32 {
			return b, nil
		}
		return nil, errors.New("LINGOLENS_SECRET must be 32 bytes, hex- or base64-encoded")
	}
	if b, err := os.ReadFile(path); err == nil {
		key, err := hex.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("%s is not a valid 32-byte hex secret", path)
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("create secret file: %w", err)
	}
	return key, nil
}
