package resolution

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

type metadataTransport struct {
	t        *testing.T
	body     string
	endpoint string
}

type registryResponses map[string]string

func (responses registryResponses) RoundTrip(req *http.Request) (*http.Response, error) {
	body, ok := responses[req.URL.String()]
	status := http.StatusOK
	if !ok {
		status = http.StatusNotFound
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
}

func TestAdditionalDefaultRegistries(t *testing.T) {
	for _, tc := range []struct {
		ecosystem, name, version, archive string
		strip                             bool
		responses                         registryResponses
	}{
		{"cargo", "itoa", "1.0.15", "https://static.crates.io/crates/itoa/itoa-1.0.15.crate", true, registryResponses{
			"https://crates.io/api/v1/crates/itoa": `{"crate":{"id":"itoa","repository":"https://github.com/dtolnay/itoa"},"versions":[{"num":"1.0.15","created_at":"2025-01-01T00:00:00Z"}]}`,
		}},
		{"pub", "path", "1.9.1", "https://pub.dev/packages/path/versions/1.9.1.tar.gz", false, registryResponses{
			"https://pub.dev/api/packages/path": `{"name":"path","latest":{"version":"1.9.1","pubspec":{"repository":"https://github.com/dart-lang/core"}},"versions":[{"version":"1.9.1","pubspec":{}}]}`,
		}},
		{"gem", "rake", "13.2.1", "https://rubygems.org/downloads/rake-13.2.1.gem", false, registryResponses{
			"https://rubygems.org/api/v1/gems/rake.json":     `{"name":"rake","version":"13.2.1","source_code_uri":"https://github.com/ruby/rake"}`,
			"https://rubygems.org/api/v1/versions/rake.json": `[{"number":"13.2.1","platform":"ruby"}]`,
		}},
	} {
		t.Run(tc.ecosystem, func(t *testing.T) {
			for _, version := range []string{tc.version, ""} {
				result, err := Resolve(t.Context(), tc.ecosystem, tc.name, version, tc.responses)
				if err != nil {
					t.Fatal(err)
				}
				if result.Archive != tc.archive || result.StripRoot != tc.strip || result.Version != tc.version {
					t.Fatalf("unexpected result: %+v", result)
				}
			}
		})
	}
}

func (m metadataTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.t.Helper()
	if req.URL.String() != m.endpoint {
		m.t.Fatalf("unexpected registry URL: %s", req.URL)
	}
	return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(m.body)), Request: req}, nil
}

func TestResolveRegistryMetadata(t *testing.T) {
	for _, tc := range []struct {
		ecosystem, name, version, endpoint, body, archive, coordinate string
	}{
		{"npm", "@scope/name", "1.0.0", "https://registry.npmjs.org/@scope%2Fname", `{"name":"@scope/name","dist-tags":{"latest":"1.0.0"},"repository":{"url":"git+https://github.com/example/name.git"},"versions":{"1.0.0":{"name":"@scope/name","version":"1.0.0","dist":{"tarball":"https://registry.npmjs.org/custom/name.tgz"}}}}`, "https://registry.npmjs.org/custom/name.tgz", "pkg:npm/%40scope/name@1.0.0"},
		{"pypi", "Example_Package", "1.0", "https://pypi.org/pypi/example-package/json", `{"info":{"name":"Example_Package","version":"1.0","project_urls":{"Source":"https://github.com/example/python"}},"releases":{"1.0":[{"packagetype":"bdist_wheel","url":"https://files.pythonhosted.org/example.whl"},{"packagetype":"sdist","url":"https://files.pythonhosted.org/example-1.0.tar.gz"}]}}`, "https://files.pythonhosted.org/example-1.0.tar.gz", "pkg:pypi/example-package@1.0"},
	} {
		t.Run(tc.ecosystem, func(t *testing.T) {
			for _, version := range []string{tc.version, ""} {
				result, err := Resolve(t.Context(), tc.ecosystem, tc.name, version, metadataTransport{t, tc.body, tc.endpoint})
				if err != nil {
					t.Fatal(err)
				}
				if result.Archive != tc.archive || result.PURL != tc.coordinate || !result.StripRoot || result.Repository == "" {
					t.Fatalf("unexpected package: %+v", result)
				}
			}
		})
	}
}

func TestResolveRejectsUnavailableArtifacts(t *testing.T) {
	for _, body := range []string{
		`{"info":{"name":"example"},"releases":{}}`,
		`{"info":{"name":"example"},"releases":{"1.0":[{"packagetype":"bdist_wheel","url":"https://files.pythonhosted.org/example.whl"}]}}`,
		`{"info":{"name":"example"},"releases":{"1.0":[{"packagetype":"sdist","url":"http://files.pythonhosted.org/example.tar.gz"}]}}`,
	} {
		_, err := Resolve(t.Context(), "pypi", "example", "1.0", metadataTransport{t, body, "https://pypi.org/pypi/example/json"})
		if err == nil {
			t.Fatalf("accepted unavailable or unsafe artifact: %s", body)
		}
	}
}

func TestProjectMetadataThroughResolution(t *testing.T) {
	responses := registryResponses{
		"https://registry.npmjs.org/example": `{"name":"example","homepage":"https://example.org/","dist-tags":{"latest":"1.0.0"},"versions":{"1.0.0":{"description":"Example description","keywords":["utility","example"],"repository":{"url":"git+https://github.com/example/project.git"},"dist":{"tarball":"https://registry.npmjs.org/example.tgz"}}}}`,
	}
	result, err := Resolve(t.Context(), "npm", "example", "1.0.0", responses)
	if err != nil {
		t.Fatal(err)
	}
	if result.Description != "Example description" || result.Homepage != "https://example.org/" || len(result.Keywords) != 2 || result.Repository == "" {
		t.Fatalf("missing normalized metadata: %+v", result)
	}
}
