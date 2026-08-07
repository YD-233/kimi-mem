# Docker

The root `docker-compose.yml` starts Kimi-Mem Server beta with a persistent Valkey sidecar.

```sh
docker compose up --build
curl http://127.0.0.1:37777/healthz
```

The server container uses:

- `KIMI_MEM_WORKER_HOST=0.0.0.0`
- `KIMI_MEM_DATA_DIR=/data/kimi-mem`
- `KIMI_MEM_QUEUE_ENGINE=bullmq`
- `KIMI_MEM_REDIS_URL=redis://valkey:6379`
- `KIMI_MEM_AUTH_MODE=api-key`

Create an API key inside the container before using protected V1 write routes.
