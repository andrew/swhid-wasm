package analyzer

import (
	"github.com/andrew/swhid-go/objects"
	"github.com/git-pkgs/archives"
	"io/fs"
	"path"
	"strings"
)

type directory struct {
	dirs  map[string]*directory
	files map[string]objects.DirectoryEntry
}

const maxDirectoryDepth = 128

func newDirectory() *directory {
	return &directory{dirs: make(map[string]*directory), files: make(map[string]objects.DirectoryEntry)}
}

func buildDirectory(entries []archives.StreamEntry, hashes map[string]string) (*directory, string) {
	byPath := make(map[string]archives.StreamEntry, len(entries))
	for _, entry := range entries {
		byPath[entry.Path] = entry
	}
	root := newDirectory()
	for _, entry := range entries {
		name := strings.TrimSuffix(entry.Path, "/")
		if !fs.ValidPath(name) || name == "." || strings.ContainsRune(name, 0) {
			return nil, "invalid archive path"
		}
		parts := strings.Split(name, "/")
		if len(parts) > maxDirectoryDepth {
			return nil, "directory depth exceeds 128"
		}
		parent := root
		directories := parts[:len(parts)-1]
		if entry.IsDir {
			directories = parts
		}
		for _, part := range directories {
			if _, exists := parent.files[part]; exists {
				return nil, "file/directory path conflict"
			}
			if parent.dirs[part] == nil {
				parent.dirs[part] = newDirectory()
			}
			parent = parent.dirs[part]
		}
		if entry.IsDir {
			continue
		}
		base := path.Base(name)
		if parent.dirs[base] != nil {
			return nil, "file/directory path conflict"
		}
		child, reason := directoryFile(entry, byPath, hashes)
		if reason != "" {
			return nil, reason
		}
		child.Name = base
		parent.files[base] = child
	}
	return root, ""
}

func directoryFile(entry archives.StreamEntry, byPath map[string]archives.StreamEntry, hashes map[string]string) (objects.DirectoryEntry, string) {
	var child objects.DirectoryEntry
	seen := make(map[string]bool)
	for entry.IsHardlink {
		if seen[entry.Path] {
			return child, "hard link cycle"
		}
		seen[entry.Path] = true
		var ok bool
		entry, ok = byPath[entry.Linkname]
		if !ok || entry.IsDir {
			return child, "hard link target unavailable"
		}
	}
	if !entry.HasMode {
		return child, "Unix mode metadata unavailable"
	}
	mode := fs.FileMode(entry.Mode)
	switch mode & fs.ModeType {
	case 0:
		child.Type = objects.EntryTypeFile
		if mode&0111 != 0 {
			child.Type = objects.EntryTypeExecutable
		}
	case fs.ModeSymlink:
		child.Type = objects.EntryTypeSymlink
	default:
		return child, "special-file metadata unsupported by archive adapter"
	}
	child.Target = hashes[entry.Path]
	if child.Target == "" {
		return child, "file content hash unavailable"
	}
	return child, ""
}

func (d *directory) hash() (string, error) {
	return d.treeHash("", nil)
}

func (d *directory) treeHash(prefix string, results *[]TreeEntry) (string, error) {
	entries := make([]objects.DirectoryEntry, 0, len(d.files)+len(d.dirs))
	for _, entry := range d.files {
		entries = append(entries, entry)
		if results != nil {
			kind := "file"
			if entry.Type == objects.EntryTypeSymlink {
				kind = "symlink"
			}
			*results = append(*results, TreeEntry{Path: path.Join(prefix, entry.Name), Type: kind, SWHID: "swh:1:cnt:" + entry.Target, Mode: entry.Permissions()})
		}
	}
	for name, child := range d.dirs {
		hash, err := child.treeHash(path.Join(prefix, name), results)
		if err != nil {
			return "", err
		}
		entries = append(entries, objects.DirectoryEntry{Name: name, Type: objects.EntryTypeDirectory, Target: hash})
	}
	hash, err := objects.ComputeDirectoryHash(entries)
	if err == nil && results != nil {
		*results = append(*results, TreeEntry{Path: prefix, Type: "directory", SWHID: "swh:1:dir:" + hash, Mode: "40000"})
	}
	return hash, err
}
