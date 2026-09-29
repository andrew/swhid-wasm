# swhid-wasm

swhid-wasm calculates Software Heritage identifiers for package archives in your browser. Load a package from npm, PyPI, Cargo, RubyGems or Dart's pub registry, or drop a local archive onto the page to see its file tree, content and directory SWHIDs, executable modes, symlinks and duplicate contents.

Go compiled to WebAssembly extracts and hashes archives locally. A Go server serves the app and relays registry requests when browser CORS rules block direct access. Preservation checks send only SWHIDs to Software Heritage. The **Archive published package** button submits a public URL for Software Heritage to download; local archive contents are never uploaded.

Hashing uses [swhid-go](https://github.com/andrew/swhid-go), and [git-pkgs/archives](https://github.com/git-pkgs/archives) reads archives with format detection from [git-pkgs/magic](https://github.com/git-pkgs/magic). Package metadata and download URLs come from [git-pkgs/registries](https://github.com/git-pkgs/registries); [git-pkgs/purl](https://github.com/git-pkgs/purl) constructs package identifiers.

## Run

Build and serve the app from the repository root with Go 1.27.1 or later, Bash and Make. Go downloads module dependencies during the first build; npm is not needed.

```sh
make serve
```

Open the `127.0.0.1` address printed by the server, on port 8080 by default. Try the prefilled `is-number` package or choose **Upload** for a local archive. Turn off **Check Software Heritage after hashing** in Settings to skip the network lookup.

After the first build, `./build/server` starts the app without rebuilding; `./build/server -port 8081` selects another port. Run it from the repository root, or pass `-root` with the path containing `web/` and `build/`. The server binds only to loopback, and the relay requires the printed `127.0.0.1` address.

## Archive handling

Supported inputs include TAR, TAR.GZ, ZIP, `.crate` and `.gem`. npm, PyPI source distributions and Cargo remove one wrapper directory; Dart keeps the archive root, and RubyGems uses the inner `data.tar.gz` root. Local uploads keep the archive root unless you enable wrapper removal in Settings.

Limits are 64 MiB of input, 64 MiB of expanded contents, 8 MiB per entry, 20,000 archive entries and 128 path components. Directory identifiers depend on names, contents, executable bits and symlink targets. ZIP archives without Unix mode metadata are rejected. A published package can have a different root identifier from its source repository or from an archive extracted with different permissions.

## Software Heritage lookups

Anubis gates API access on the combination of `User-Agent` and `Accept` headers. Browser JavaScript cannot set `Accept` on a CORS `OPTIONS` preflight, which blocks cross-origin access to a large part of the API. During testing, preflights for JSON `POST` requests to `/api/1/known/` received HTML challenges without the required CORS headers, so the browser never sent the `POST`.

The browser sends batches of up to 500 SWHIDs to the same-origin `/api/swh/known` route, where the Go server forwards them to Software Heritage without a browser CORS preflight. This lookup relay is separate from the configurable registry fetch proxy.

Software Heritage can still rate-limit or reject a lookup; completed batches are retained when you retry. Files can be known to Software Heritage even when the package's directory root is unknown.

Fixing Anubis and pointing the client at the upstream API would allow static hosting for local archive hashing and preservation lookups. Package resolution already runs in browser WASM, and npm, PyPI and Cargo worked directly during testing. RubyGems metadata and Dart downloads had separate CORS failures, so those requests would still need a proxy.

## Test

Tests also require Node 26 or later, Chrome or Chromium, `tar` and `zip`. Set `CHROME_BIN` if the browser is not installed at the default Chrome path on macOS or as `google-chrome` on Linux.

```sh
make test
```

`make test` builds the app and runs the Go and JavaScript tests. Tests compare native and WASM archive hashes, then upload a generated archive through headless Chrome and check the displayed root against an independently calculated Git tree hash. The default suite makes no registry or Software Heritage requests; use the following command to test npm resolution and a preservation lookup over the network:

```sh
LIVE_REGISTRY=1 node --test scripts/ui.test.mjs
```

## License

The project uses the [MIT license](LICENSE); dependencies retain their upstream licenses. Building the WASM assets also copies Go's runtime license to `build/GO-LICENSE`.
