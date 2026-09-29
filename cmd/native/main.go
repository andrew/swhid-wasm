package main

import (
	"fmt"
	"github.com/andrew/swhid-wasm/analyzer"
	"io"
	"os"
)

const argumentCount = 3
const usageExit = 2

func main() {
	if len(os.Args) != argumentCount {
		fmt.Fprintln(os.Stderr, "usage: native OPERATION NAME < FILE")
		os.Exit(usageExit)
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, analyzer.MaxInput+1))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	output, status := analyzer.Run(os.Args[1], os.Args[2], data)
	if _, err := os.Stdout.Write(append(output, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if status != analyzer.StatusOK {
		os.Exit(1)
	}
}
