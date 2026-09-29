package analyzer

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/andrew/swhid-go/objects"
)

const packageOperation = "package"

func TestPackageEntryLimitThroughRun(t *testing.T) {
	headers := make([]tar.Header, MaxPackageEntries+1)
	for i := range headers {
		headers[i] = tar.Header{Name: fmt.Sprintf("package/entry-%d", i), Mode: 0644}
	}
	for _, operation := range []string{packageOperation, "package-strip"} {
		output, status := Run(operation, "many.tar", tarHeaders(t, headers[:MaxPackageEntries]...))
		if status != StatusOK {
			t.Fatalf("%s at limit: %d %s", operation, status, output)
		}
		var tree PackageTree
		if err := json.Unmarshal(output, &tree); err != nil {
			t.Fatal(err)
		}
		files := 0
		for _, entry := range tree.Entries {
			if entry.Type == fileOperation {
				files++
			}
		}
		if files != MaxPackageEntries {
			t.Fatalf("got %d files, want %d", files, MaxPackageEntries)
		}
		output, status = Run(operation, "many.tar", tarHeaders(t, headers...))
		if status != statusUnprocessable || !bytes.Contains(output, []byte("entry count exceeds limit")) {
			t.Fatalf("%s above limit: %d %s", operation, status, output)
		}
	}
}

func TestPackageThroughRun(t *testing.T) {
	input := tarHeaders(t,
		tar.Header{Name: "./package/", Typeflag: tar.TypeDir, Mode: 0755},
		tar.Header{Name: "./package/bin/run", Typeflag: tar.TypeReg, Size: 1, Mode: 0755},
		tar.Header{Name: "./package/link", Typeflag: tar.TypeSymlink, Linkname: "bin/run", Mode: 0777},
		tar.Header{Name: "./package/alias", Typeflag: tar.TypeLink, Linkname: "./package/bin/run", Mode: 0644},
		tar.Header{Name: "./package/empty/", Typeflag: tar.TypeDir, Mode: 0700},
	)
	output, status := Run("package-strip", "source.tar", input)
	if status != StatusOK {
		t.Fatal(string(output))
	}
	var tree PackageTree
	if err := json.Unmarshal(output, &tree); err != nil {
		t.Fatal(err)
	}
	if tree.Stripped != packageOperation || tree.Root == tree.ArchiveRoot || len(tree.Entries) != 6 {
		t.Fatalf("unexpected tree: %+v", tree)
	}
	byPath := make(map[string]TreeEntry)
	for _, entry := range tree.Entries {
		byPath[entry.Path] = entry
	}
	if byPath["bin/run"].Mode != "100755" || byPath["alias"].SWHID != byPath["bin/run"].SWHID || byPath["alias"].Mode != "100755" {
		t.Fatal(byPath)
	}
	target, err := objects.ComputeContentHash([]byte("bin/run"))
	if err != nil {
		t.Fatal(err)
	}
	if byPath[linkName].SWHID != "swh:1:cnt:"+target || byPath[linkName].Mode != "120000" {
		t.Fatal(byPath[linkName])
	}
	if byPath[""].SWHID != tree.Root {
		t.Fatal("missing root entry")
	}
	if byPath["bin/run"].Size != 1 || byPath["alias"].Size != 1 || byPath[linkName].Size != 7 {
		t.Fatalf("incorrect entry sizes: %+v", byPath)
	}
	if tree.UnpackedBytes != 9 {
		t.Fatalf("unpacked bytes: got %d, want 9 including hard link and symlink target", tree.UnpackedBytes)
	}
	full, status := Run(packageOperation, "source.tar", input)
	if status != StatusOK {
		t.Fatal(string(full))
	}
	var archive PackageTree
	if err := json.Unmarshal(full, &archive); err != nil {
		t.Fatal(err)
	}
	if archive.Root != tree.ArchiveRoot {
		t.Fatal("archive root differs")
	}
}

func TestPackageRejectsAmbiguousTrees(t *testing.T) {
	tests := []struct {
		name    string
		headers []tar.Header
		strip   bool
		message string
	}{
		{"traversal", []tar.Header{{Name: "../escape", Mode: 0644}}, false, "invalid archive path"},
		{"duplicate", []tar.Header{{Name: fileOperation, Mode: 0644}, {Name: "./file", Mode: 0644}}, false, "duplicate archive path"},
		{"conflict", []tar.Header{{Name: fileOperation, Mode: 0644}, {Name: "file/child", Mode: 0644}}, false, "path conflict"},
		{"hardlink", []tar.Header{{Name: linkName, Typeflag: tar.TypeLink, Linkname: "absent"}}, false, "target unavailable"},
		{"cycle", []tar.Header{{Name: linkName, Typeflag: tar.TypeLink, Linkname: linkName}}, false, "cycle"},
		{"wrapper", []tar.Header{{Name: fileOperation, Mode: 0644}}, true, "wrapper"},
		{"special", []tar.Header{{Name: "fifo", Typeflag: tar.TypeFifo}}, false, "special file"},
		{"depth", []tar.Header{{Name: strings.Repeat("a/", 129) + fileOperation, Mode: 0644}}, false, "depth"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			operation := packageOperation
			if tt.strip {
				operation = "package-strip"
			}
			result, status := Run(operation, "source.tar", tarHeaders(t, tt.headers...))
			if status == StatusOK || !strings.Contains(string(result), tt.message) {
				t.Fatalf("%d: %s", status, result)
			}
		})
	}
}

func TestPackageZIPModes(t *testing.T) {
	for _, unix := range []bool{false, true} {
		var buf bytes.Buffer
		writer := zip.NewWriter(&buf)
		header := &zip.FileHeader{Name: "bin/run"}
		if unix {
			header.SetMode(0755)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = entry.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		result, status := Run(packageOperation, "source.zip", buf.Bytes())
		if unix && status != StatusOK {
			t.Fatal(string(result))
		}
		if !unix && (status == StatusOK || !strings.Contains(string(result), "Unix mode")) {
			t.Fatal(string(result))
		}
	}
}

const fileOperation = "file"
const linkName = "link"

func tarHeaders(t *testing.T, headers ...tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := tar.NewWriter(&buf)
	for i := range headers {
		if err := w.WriteHeader(&headers[i]); err != nil {
			t.Fatal(err)
		}
		if headers[i].Size != 0 {
			if _, err := w.Write(bytes.Repeat([]byte("x"), int(headers[i].Size))); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
