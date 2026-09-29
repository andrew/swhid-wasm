package analyzer

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/andrew/swhid-go/objects"
	"github.com/git-pkgs/archives"
)

const MaxPackageEntries = 20000

type TreeEntry struct {
	Path  string `json:"path"`
	Type  string `json:"type"`
	SWHID string `json:"swhid"`
	Mode  string `json:"mode"`
	Size  int64  `json:"size"`
}

type PackageTree struct {
	Root          string      `json:"root"`
	ArchiveRoot   string      `json:"archiveRoot"`
	Stripped      string      `json:"stripped"`
	Entries       []TreeEntry `json:"entries"`
	UnpackedBytes int64       `json:"unpackedBytes"`
}

func PackageIdentity(name string, data []byte, stripRoot bool) (result PackageTree, err error) {
	r, err := archives.OpenStreamBytes(name, data, archives.StreamOptions{
		MaxInputBytes: MaxInput, MaxEntryBytes: MaxFile, MaxExpandedBytes: MaxExpanded, MaxEntries: MaxPackageEntries,
	})
	if err != nil {
		return result, err
	}
	defer func() { err = errors.Join(err, r.Close()) }()
	entries, hashes, err := packageEntries(r)
	if err != nil {
		return result, err
	}
	root, reason := buildDirectory(entries, hashes)
	if reason != "" {
		return result, errors.New(reason)
	}
	archiveHash, err := root.hash()
	if err != nil {
		return result, err
	}
	result.ArchiveRoot = "swh:1:dir:" + archiveHash
	if stripRoot {
		if len(root.files) != 0 || len(root.dirs) != 1 {
			return result, fmt.Errorf("expected exactly one wrapper directory; choose archive root for this file")
		}
		for name, child := range root.dirs {
			result.Stripped = name
			root = child
		}
	}
	hash, err := root.treeHash("", &result.Entries)
	if err != nil {
		return result, err
	}
	result.Root = "swh:1:dir:" + hash
	result.UnpackedBytes = unpackedSize(result.Entries, entries, hashes)
	sort.Slice(result.Entries, func(i, j int) bool { return result.Entries[i].Path < result.Entries[j].Path })
	return result, nil
}

func unpackedSize(tree []TreeEntry, entries []archives.StreamEntry, hashes map[string]string) int64 {
	sizes := make(map[string]int64)
	for _, entry := range entries {
		if entry.IsDir || entry.IsHardlink {
			continue
		}
		size := entry.Size
		if fs.FileMode(entry.Mode)&fs.ModeSymlink != 0 && entry.Linkname != "" {
			size = int64(len(entry.Linkname))
		}
		sizes["swh:1:cnt:"+hashes[entry.Path]] = size
	}
	var total int64
	for i, entry := range tree {
		if entry.Type != "directory" {
			tree[i].Size = sizes[entry.SWHID]
			total += tree[i].Size
		}
	}
	return total
}

func packageEntries(r *archives.Stream) ([]archives.StreamEntry, map[string]string, error) {
	var entries []archives.StreamEntry
	hashes := make(map[string]string)
	seen := make(map[string]bool)
	for {
		entry, nextErr := r.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return nil, nil, nextErr
		}
		entry.Path = strings.TrimSuffix(strings.TrimPrefix(entry.Path, "./"), "/")
		if entry.IsDir && (entry.Path == "." || entry.Path == "") {
			continue
		}
		if !utf8.ValidString(entry.Path) {
			return nil, nil, fmt.Errorf("non-UTF-8 archive path")
		}
		if seen[entry.Path] {
			return nil, nil, fmt.Errorf("duplicate archive path: %s", entry.Path)
		}
		seen[entry.Path] = true
		if entry.IsHardlink {
			entry.Linkname = strings.TrimPrefix(entry.Linkname, "./")
		}
		entries = append(entries, *entry)
		if entry.IsDir || entry.IsHardlink {
			continue
		}
		mode := fs.FileMode(entry.Mode)
		if mode&fs.ModeType != 0 && mode&fs.ModeSymlink == 0 {
			return nil, nil, fmt.Errorf("unsupported special file: %s", entry.Path)
		}
		var hash string
		var hashErr error
		if mode&fs.ModeSymlink != 0 && entry.Linkname != "" {
			hash, hashErr = objects.ComputeContentHash([]byte(entry.Linkname))
		} else {
			hash, hashErr = objects.ComputeContentHashReader(r, entry.Size)
		}
		if hashErr != nil {
			return nil, nil, hashErr
		}
		hashes[entry.Path] = hash
	}
	return entries, hashes, nil
}
