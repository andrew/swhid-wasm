package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

const originHeader = "Origin"

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func response(r *http.Request, status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}
}

func start(t *testing.T, transport transportFunc) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(New(os.DirFS(".."), transport))
	t.Cleanup(s.Close)
	return s
}

func request(t *testing.T, s *httptest.Server, method, path, body string, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	r, err := http.NewRequest(method, s.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		if key == "Host" {
			r.Host = value
		} else {
			r.Header.Set(key, value)
		}
	}
	res, err := s.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, data
}

func TestAssetsThroughHTTP(t *testing.T) {
	s := start(t, nil)
	for path, asset := range assets {
		res, data := request(t, s, http.MethodGet, path, "", nil)
		if res.StatusCode != http.StatusOK || len(data) == 0 || res.Header.Get("Content-Type") != asset.contentType {
			t.Fatalf("%s: status=%d type=%s bytes=%d", path, res.StatusCode, res.Header.Get("Content-Type"), len(data))
		}
		if strings.HasSuffix(path, ".wasm") && !bytes.HasPrefix(data, []byte{0, 'a', 's', 'm'}) {
			t.Fatalf("invalid WASM: %s", path)
		}
	}
	for _, path := range []string{"/go.mod", "/LICENSE", "/build/native", "/.git/config", "/../go.mod"} {
		res, _ := request(t, s, http.MethodGet, path, "", nil)
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("exposed %s", path)
		}
	}
}

func TestKnownThroughHTTP(t *testing.T) {
	id := "swh:1:cnt:" + strings.Repeat("a", 40)
	body := `["` + id + `"]`
	s := start(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != knownURL || r.Method != http.MethodPost || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected upstream request: %s %s", r.Method, r.URL)
		}
		got, err := io.ReadAll(r.Body)
		if err != nil || string(got) != body {
			t.Errorf("body: %s, %v", got, err)
		}
		return response(r, http.StatusOK, `{"`+id+`":{"known":true,"extra":"omit"},"other":{"known":false}}`), nil
	})
	res, data := request(t, s, http.MethodPost, "/api/swh/known", body, map[string]string{originHeader: s.URL, "Cookie": "secret=value", "Authorization": "Bearer secret"})
	var result map[string]map[string]bool
	if res.StatusCode != http.StatusOK || json.Unmarshal(data, &result) != nil || len(result) != 1 || !result[id]["known"] || len(result[id]) != 1 {
		t.Fatalf("%d %s", res.StatusCode, data)
	}
}

func TestKnownRejectsInvalidRequests(t *testing.T) {
	s := start(t, func(_ *http.Request) (*http.Response, error) {
		t.Error("invalid request forwarded")
		return nil, fmt.Errorf("unexpected request")
	})
	valid := `["swh:1:cnt:` + strings.Repeat("a", 40) + `"]`
	for _, tc := range []struct {
		method, body string
		headers      map[string]string
		status       int
	}{
		{http.MethodGet, "", nil, http.StatusMethodNotAllowed},
		{http.MethodPost, valid, map[string]string{originHeader: "https://example.com"}, http.StatusForbidden},
		{http.MethodPost, valid, map[string]string{"Host": "example.com"}, http.StatusForbidden},
		{http.MethodPost, valid, map[string]string{"Sec-Fetch-Site": "cross-site"}, http.StatusForbidden},
		{http.MethodPost, valid, map[string]string{"Content-Type": "text/plain"}, http.StatusUnsupportedMediaType},
		{http.MethodPost, `[]`, nil, http.StatusBadRequest},
		{http.MethodPost, `["file contents"]`, nil, http.StatusBadRequest},
		{http.MethodPost, `{`, nil, http.StatusBadRequest},
		{http.MethodPost, `[` + strings.Repeat(`"x",`, maxKnownIDs) + `"x"]`, nil, http.StatusBadRequest},
		{http.MethodPost, strings.Repeat("x", maxKnownBody+1), nil, http.StatusRequestEntityTooLarge},
	} {
		res, data := request(t, s, tc.method, "/api/swh/known", tc.body, tc.headers)
		if res.StatusCode != tc.status {
			t.Fatalf("want %d, got %d: %s", tc.status, res.StatusCode, data)
		}
	}
}

func TestKnownUpstreamFailures(t *testing.T) {
	for _, tc := range []struct {
		upstream int
		body     string
		want     int
	}{
		{http.StatusTooManyRequests, "", http.StatusTooManyRequests},
		{http.StatusOK, "<html>challenge</html>", http.StatusBadGateway},
		{http.StatusOK, `{}`, http.StatusBadGateway},
		{http.StatusFound, "", http.StatusBadGateway},
	} {
		s := start(t, func(r *http.Request) (*http.Response, error) {
			res := response(r, tc.upstream, tc.body)
			res.Header.Set("Retry-After", "60")
			res.Header.Set("Location", "https://example.com")
			return res, nil
		})
		res, data := request(t, s, http.MethodPost, "/api/swh/known", `["swh:1:dir:`+strings.Repeat("a", 40)+`"]`, nil)
		if res.StatusCode != tc.want {
			t.Fatalf("%d %s", res.StatusCode, data)
		}
		if tc.upstream == http.StatusTooManyRequests && res.Header.Get("Retry-After") != "60" {
			t.Fatal("lost rate limit")
		}
	}
}

func TestRegistryProxyThroughHTTP(t *testing.T) {
	calls := 0
	body := "\x00\xff\x1f\x8b\x00"
	s := start(t, func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("credentials forwarded")
		}
		if calls == 1 {
			res := response(r, http.StatusSeeOther, "")
			res.Header.Set("Location", "/api/archives/path.tar.gz")
			return res, nil
		}
		if r.URL.String() != "https://pub.dev/api/archives/path.tar.gz" {
			t.Errorf("wrong redirect: %s", r.URL)
		}
		res := response(r, http.StatusOK, body)
		res.Header.Set("Content-Type", "application/gzip")
		return res, nil
	})
	res, data := request(t, s, http.MethodGet, "/api/registry/fetch?url="+url.QueryEscape("https://pub.dev/archive.tar.gz"), "", map[string]string{"Cookie": "secret=value"})
	if res.StatusCode != http.StatusOK || string(data) != body || calls != 2 {
		t.Fatalf("%d %q, calls=%d", res.StatusCode, data, calls)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unexpected CORS permission")
	}
}

func TestRegistryProxyRestrictions(t *testing.T) {
	calls := 0
	s := start(t, func(r *http.Request) (*http.Response, error) {
		calls++
		res := response(r, http.StatusFound, "")
		res.Header.Set("Location", "http://127.0.0.1/private")
		return res, nil
	})
	for _, raw := range []string{"http://pub.dev/a", "https://pub.dev:444/a", "https://user:password@pub.dev/a", "https://example.com/a", "https://pub.dev.example.com/a", "file:///etc/passwd"} {
		res, _ := request(t, s, http.MethodGet, "/api/registry/fetch?url="+url.QueryEscape(raw), "", nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("accepted %s", raw)
		}
	}
	endpoint := "/api/registry/fetch?url=" + url.QueryEscape("https://pub.dev/archive.tar.gz")
	for _, tc := range []struct {
		method  string
		headers map[string]string
		status  int
	}{
		{http.MethodGet, map[string]string{originHeader: "https://example.com"}, http.StatusForbidden},
		{http.MethodPost, nil, http.StatusMethodNotAllowed},
	} {
		res, _ := request(t, s, tc.method, endpoint, "", tc.headers)
		if res.StatusCode != tc.status {
			t.Fatalf("want %d, got %d", tc.status, res.StatusCode)
		}
	}
	if calls != 0 {
		t.Fatal("invalid request forwarded")
	}
	res, _ := request(t, s, http.MethodGet, endpoint, "", nil)
	if res.StatusCode != http.StatusBadGateway || calls != 1 {
		t.Fatal("unsafe redirect followed")
	}
}

func TestRegistrySizeLimitsAndErrors(t *testing.T) {
	for _, tc := range []struct {
		declared       int64
		body           string
		upstream, want int
	}{
		{maxBytes + 1, "large", http.StatusOK, http.StatusRequestEntityTooLarge},
		{-1, strings.Repeat("x", maxBytes+1), http.StatusOK, http.StatusRequestEntityTooLarge},
		{0, "missing", http.StatusNotFound, http.StatusNotFound},
	} {
		s := start(t, func(r *http.Request) (*http.Response, error) {
			res := response(r, tc.upstream, tc.body)
			res.ContentLength = tc.declared
			return res, nil
		})
		res, data := request(t, s, http.MethodGet, "/api/registry/fetch?url="+url.QueryEscape("https://pub.dev/archive.tar.gz"), "", nil)
		if res.StatusCode != tc.want {
			t.Fatalf("%d %s", res.StatusCode, data)
		}
	}
}
