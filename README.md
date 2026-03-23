# Amazon Ring Recorder

Records segmented MP4 clips whenever motion is detected. Tokens rotate automatically. Designed to run forever in a container.

> **Disclaimer**: this project is for educational and personal learning purposes only. It relies on [`ring-client-api`](https://github.com/dgreif/ring), an unofficial, reverse-engineered API that is not endorsed by, affiliated with, or supported by Amazon Ring. Use of this API may violate [Ring's Terms of Service](https://ring.com/terms). By using this project, you accept full responsibility for any consequences.

## Compatibility

| OS                 | Status |
| ------------------ | ------ |
| macOS              | ✅     |
| Linux              | ✅     |
| Windows (via WSL2) | ✅     |
| Native Windows     | ✅     |

## Prerequisites

- [Docker](https://www.docker.com) and Docker Compose
- [Node.js](https://nodejs.org)
- [Bun](https://bun.sh)
- [Lima](https://github.com/lima-vm/lima) and `lima-additional-guestagents` for local deployment tests

## Installation

### Local

```bash
bun install
cp .env.example .env
bun run token:generate
bun run build && bun start
```

### Docker

```bash
cp .env.example .env
bun run token:generate
docker compose up -d --build
```

### Remote deployment

Compile locally on the host and deploy the Docker image to the remote host.

```bash
cp .env.example .env
bun run token:generate
bun run deploy -- \
    --host <HOST> \
    --port <PORT> \
    --user <USER> \
    --identityFile <IDENTITY_FILE> \
    --arch <ARCH>
```

### Local deployment

Compile locally on the host and deploy the Docker image to the simulated remote host.

```bash
cp .env.example .env
bun run token:generate
ARCH=<ARCH> bun run lima:generate
bun run lima:deploy
```

**Available architectures:** `amd64` (default), `arm64`
