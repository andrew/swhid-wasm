package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

const (
	javascriptType   = "text/javascript"
	knownTimeout     = 25 * time.Second
	maxKnownResponse = 1 << 20
	maxBytes         = 64 << 20
	maxKnownBody     = 32768
	maxKnownIDs      = 500
	maxRedirects     = 5
	knownURL         = "https://archive.softwareheritage.org/api/1/known/"
)

var identifier = regexp.MustCompile(`^swh:1:(cnt|dir):[0-9a-f]{40}$`)

var registryHosts = map[string]bool{
	"registry.npmjs.org": true, "pypi.org": true, "files.pythonhosted.org": true,
	"crates.io": true, "static.crates.io": true, "rubygems.org": true, "pub.dev": true,
}

var assets = map[string]struct{ path, contentType string }{
	"/":                       {"web/index.html", "text/html; charset=utf-8"},
	"/style.css":              {"web/style.css", "text/css; charset=utf-8"},
	"/app.mjs":                {"web/app.mjs", javascriptType},
	"/core.mjs":               {"web/core.mjs", javascriptType},
	"/wasm.mjs":               {"web/wasm.mjs", javascriptType},
	"/hash-worker.mjs":        {"web/hash-worker.mjs", javascriptType},
	"/resolve.mjs":            {"web/resolve.mjs", javascriptType},
	"/resolve-worker.mjs":     {"web/resolve-worker.mjs", javascriptType},
	"/tree.mjs":               {"web/tree.mjs", javascriptType},
	"/build/resolver.wasm":    {"build/resolver.wasm", "application/wasm"},
	"/build/analyzer-go.wasm": {"build/analyzer-go.wasm", "application/wasm"},
	"/build/go-wasm_exec.js":  {"build/go-wasm_exec.js", javascriptType},
}

type Server struct {
	files  fs.FS
	client *http.Client
}

func New(files fs.FS, transport http.RoundTripper) *Server {
	return &Server{files: files, client: &http.Client{
		Transport:     transport,
		Timeout:       time.Minute,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	switch r.URL.Path {
	case "/api/swh/known", "/api/registry/fetch":
		if !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "Only same-origin local requests are accepted.")
			return
		}
		if r.URL.Path == "/api/swh/known" {
			s.known(w, r)
		} else {
			s.registry(w, r)
		}
	default:
		asset, ok := assets[r.URL.Path]
		if !ok || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		body, err := fs.ReadFile(s.files, asset.path)
		if err != nil {
			http.Error(w, "Asset unavailable. Run make build first.", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", asset.contentType)
		_, _ = w.Write(body)
	}
}

func sameOrigin(r *http.Request) bool {
	local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	if !ok || r.Host != local.String() || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	return r.Header.Get("Origin") == "" || r.Header.Get("Origin") == "http://"+r.Host
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (s *Server) known(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "POST required.")
		return
	}
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "JSON required.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxKnownBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "Request too large or unreadable.")
		return
	}
	var ids []string
	if json.Unmarshal(body, &ids) != nil || len(ids) == 0 || len(ids) > maxKnownIDs {
		writeError(w, http.StatusBadRequest, "Expected 1–500 content or directory SWHIDs.")
		return
	}
	for _, id := range ids {
		if !identifier.MatchString(id) {
			writeError(w, http.StatusBadRequest, "Invalid SWHID.")
			return
		}
	}
	s.forwardKnown(w, r, ids, body)
}

func (s *Server) forwardKnown(w http.ResponseWriter, r *http.Request, ids []string, body []byte) {
	ctx, cancel := context.WithTimeout(r.Context(), knownTimeout)
	defer cancel()
	upstream, err := http.NewRequestWithContext(ctx, http.MethodPost, knownURL, bytes.NewReader(body))
	if err != nil {
		writeError(w, http.StatusBadGateway, "Could not create preservation request.")
		return
	}
	upstream.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(upstream)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Software Heritage could not be reached. Retry later.")
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		if retry := response.Header.Get("Retry-After"); retry != "" {
			w.Header().Set("Retry-After", retry)
		}
		writeError(w, upstreamStatus(response.StatusCode), fmt.Sprintf("Software Heritage returned HTTP %d.", response.StatusCode))
		return
	}
	var result map[string]struct {
		Known *bool `json:"known"`
	}
	err = json.NewDecoder(io.LimitReader(response.Body, maxKnownResponse)).Decode(&result)
	filtered := make(map[string]struct {
		Known bool `json:"known"`
	}, len(ids))
	for _, id := range ids {
		if err != nil || result[id].Known == nil {
			writeError(w, http.StatusBadGateway, "Software Heritage returned an invalid response. Retry later.")
			return
		}
		filtered[id] = struct {
			Known bool `json:"known"`
		}{Known: *result[id].Known}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(filtered)
}

func upstreamStatus(status int) int {
	if status >= http.StatusBadRequest {
		return status
	}
	return http.StatusBadGateway
}

func allowed(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || !registryHosts[u.Host] || u.User != nil {
		return nil, fmt.Errorf("URL must use an allowed public registry over HTTPS")
	}
	return u, nil
}

func (s *Server) registry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "GET required.")
		return
	}
	u, err := allowed(r.URL.Query().Get("url"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
	defer cancel()
	for redirects := 0; redirects <= maxRedirects; redirects++ {
		next, err := s.fetchRegistry(ctx, w, u)
		if err != nil {
			writeError(w, http.StatusBadGateway, "Registry fetch failed or redirected outside the allowed registries.")
			return
		}
		if next == nil {
			return
		}
		u = next
	}
	writeError(w, http.StatusBadGateway, "Too many registry redirects.")
}

func (s *Server) fetchRegistry(ctx context.Context, w http.ResponseWriter, u *url.URL) (*url.URL, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("User-Agent", "swhid-wasm")
	response, err := s.client.Do(r)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	switch response.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		next, err := response.Location()
		if err != nil {
			return nil, err
		}
		return allowed(next.String())
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, upstreamStatus(response.StatusCode), fmt.Sprintf("Registry returned HTTP %d.", response.StatusCode))
		return nil, nil
	}
	if response.ContentLength > maxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "Registry response exceeds 64 MiB.")
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "Registry response exceeds 64 MiB.")
		return nil, nil
	}
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(body)
	return nil, nil
}
