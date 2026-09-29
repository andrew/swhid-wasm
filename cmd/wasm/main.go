//go:build js && wasm && !tinygo

package main

import (
	"github.com/andrew/swhid-wasm/analyzer"
	"unsafe"
)

const invalidRequestStatus = 400

var input, output []byte
var status int
var operations = [...]string{"package", "package-strip"}

func main() { select {} }

//go:wasmexport reserve
func Reserve(size uint32) uint32 {
	if size == 0 || size > analyzer.MaxInput+1024 {
		return 0
	}
	input = make([]byte, size)
	output = nil
	return uint32(uintptr(unsafe.Pointer(&input[0])))
}

//go:wasmexport analyze
func Analyze(operation, nameSize uint32) uint32 {
	if operation >= uint32(len(operations)) || nameSize > uint32(len(input)) {
		output, status = analyzer.Error("invalid request", invalidRequestStatus)
	} else {
		output, status = analyzer.Run(operations[operation], string(input[:nameSize]), input[nameSize:])
	}
	input = nil
	return uint32(status)
}

//go:wasmexport result_ptr
func ResultPtr() uint32 { return uint32(uintptr(unsafe.Pointer(&output[0]))) }

//go:wasmexport result_len
func ResultLen() uint32 { return uint32(len(output)) }

//go:wasmexport release_result
func ReleaseResult() { output = nil }
