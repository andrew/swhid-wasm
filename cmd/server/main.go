package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/andrew/swhid-wasm/server"
)

const (
	defaultPort   = 8080
	headerTimeout = 5 * time.Second
	readTimeout   = 10 * time.Second
	writeTimeout  = 70 * time.Second
)

func main() {
	port := flag.Int("port", defaultPort, "local HTTP port")
	root := flag.String("root", ".", "directory containing web and build")
	flag.Parse()
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("SWHID calculator: http://%s", listener.Addr())
	app := &http.Server{
		Handler:           server.New(os.DirFS(*root), nil),
		ReadHeaderTimeout: headerTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       time.Minute,
	}
	log.Fatal(app.Serve(listener))
}
