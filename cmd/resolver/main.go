//go:build js && wasm

package main

import (
	"context"
	"encoding/json"
	"github.com/andrew/swhid-wasm/resolution"
	"syscall/js"
	"time"
)

func main() {
	js.Global().Set("resolvePackage", js.FuncOf(resolve))
	select {}
}

func resolve(_ js.Value, args []js.Value) any {
	ecosystem, name, version := args[0].String(), args[1].String(), args[2].String()
	executor := js.FuncOf(func(_ js.Value, callbacks []js.Value) any {
		accept, reject := callbacks[0], callbacks[1]
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			result, err := resolution.Resolve(ctx, ecosystem, name, version, nil)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			data, err := json.Marshal(result)
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			accept.Invoke(js.Global().Get("JSON").Call("parse", string(data)))
		}()
		return nil
	})
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}
