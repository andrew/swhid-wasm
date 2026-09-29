package analyzer

import "encoding/json"

const (
	MaxInput            = 64 << 20
	MaxFile             = 8 << 20
	MaxOutput           = 16 << 20
	MaxExpanded         = 64 << 20
	StatusOK            = 200
	statusBadRequest    = 400
	statusNotFound      = 404
	statusTooLarge      = 413
	statusUnprocessable = 422
	statusInternalError = 500
)

func Run(operation, name string, data []byte) ([]byte, int) {
	if len(data) > MaxInput {
		return Error("input exceeds 64 MiB", statusTooLarge)
	}
	if len(name) == 0 || len(name) > 1024 {
		return Error("name must contain 1 to 1024 bytes", statusBadRequest)
	}
	var result any
	var err error
	switch operation {
	case "package", "package-strip":
		result, err = PackageIdentity(name, data, operation == "package-strip")
	default:
		return Error("unknown operation", statusNotFound)
	}
	if err != nil {
		return Error(err.Error(), statusUnprocessable)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return Error(err.Error(), statusInternalError)
	}
	if len(encoded) > MaxOutput {
		return Error("output exceeds 16 MiB", statusTooLarge)
	}
	return encoded, StatusOK
}

func Error(message string, status int) ([]byte, int) {
	encoded, _ := json.Marshal(map[string]string{"error": message})
	return encoded, status
}
