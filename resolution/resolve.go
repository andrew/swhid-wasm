package resolution

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/git-pkgs/purl"
	"github.com/git-pkgs/registries"
	_ "github.com/git-pkgs/registries/all"
)

type Package struct {
	Name        string   `json:"name"`
	Version     string   `json:"version"`
	Ecosystem   string   `json:"ecosystem"`
	PURL        string   `json:"purl"`
	Archive     string   `json:"archive"`
	Filename    string   `json:"filename"`
	Repository  string   `json:"repository"`
	Homepage    string   `json:"homepage"`
	Description string   `json:"description"`
	Keywords    []string `json:"keywords"`
	StripRoot   bool     `json:"stripRoot"`
}

var packageRoots = map[string]bool{
	"npm": true, "pypi": true, "cargo": true,
	"gem": false, "pub": false,
}

func Resolve(ctx context.Context, ecosystem, name, version string, transport http.RoundTripper) (*Package, error) {
	name, version = strings.TrimSpace(name), strings.TrimSpace(version)
	stripRoot, supported := packageRoots[ecosystem]
	if name == "" || !supported {
		return nil, fmt.Errorf("choose a supported ecosystem and package")
	}
	client := registries.NewClient(registries.WithHTTPClient(&http.Client{Transport: transport}), registries.WithMaxRetries(0))
	coordinate := purl.MakePURLString(ecosystem, name, version)
	reg, name, version, err := registries.NewFromPURL(coordinate, client)
	if err != nil {
		return nil, err
	}
	pkg, err := reg.FetchPackage(ctx, name)
	if err != nil {
		return nil, err
	}
	var release *registries.Version
	if version == "" {
		release, err = registries.FetchLatestVersion(ctx, reg, name)
	} else {
		release, err = registries.FetchVersionFromPURL(ctx, coordinate, client)
	}
	if err != nil {
		return nil, err
	}
	if release == nil || release.Number == "" {
		return nil, fmt.Errorf("no release available for %s", name)
	}
	archive, err := archiveURL(ecosystem, release, reg.URLs().Download(name, release.Number))
	if err != nil {
		return nil, err
	}
	parsed, err := url.Parse(archive)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, fmt.Errorf("registry archive URL must use HTTPS without credentials")
	}
	return &Package{
		Name: name, Version: release.Number, Ecosystem: ecosystem,
		PURL:    purl.MakePURLString(ecosystem, name, release.Number),
		Archive: archive, Filename: path.Base(parsed.Path), Repository: pkg.Repository, StripRoot: stripRoot,
		Homepage: pkg.Homepage, Description: pkg.Description, Keywords: pkg.Keywords,
	}, nil
}

func archiveURL(ecosystem string, release *registries.Version, fallback string) (string, error) {
	if ecosystem == "pypi" {
		var matches []string
		for _, artifact := range release.Artifacts {
			if artifact.Metadata["packagetype"] == "sdist" && supportedSource(artifact.Filename) {
				matches = append(matches, artifact.URL)
			}
		}
		if len(matches) != 1 {
			return "", fmt.Errorf("expected one supported PyPI source distribution (.tar.gz or .zip)")
		}
		return matches[0], nil
	}
	for _, key := range []string{"tarball", "download_url"} {
		if value, ok := release.Metadata[key].(string); ok && value != "" {
			return value, nil
		}
	}
	if fallback == "" {
		return "", fmt.Errorf("registry did not provide an archive URL")
	}
	return fallback, nil
}

func supportedSource(name string) bool {
	return strings.HasSuffix(name, ".tar.gz") || strings.HasSuffix(name, ".tgz") || strings.HasSuffix(name, ".zip")
}
