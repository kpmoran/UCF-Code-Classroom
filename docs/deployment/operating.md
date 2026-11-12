# Operating it

```bash
cd /opt/uccc
docker compose ps                      # what is running
docker compose logs -f app             # application and job worker
docker compose up -d app               # apply an .env change (recreates the container)
docker compose exec postgres psql -U uccc -d uccc
docker compose exec -T postgres pg_dump -U uccc uccc | gzip > ~/uccc-$(date +%F).sql.gz
```

**Applying a change to `/opt/uccc/.env` needs `up -d`, not `restart`.** A container's
environment is fixed when it is created, so `restart` reuses the old values and looks
like the edit did nothing.

The deploy writes `docker-compose.override.yml` next to the compose file, pinning the
exact image it deployed. Compose merges it automatically, so a plain `docker compose
up -d` reuses that image rather than resolving the base file's `:latest` default —
which would otherwise swap a running deployment to a different build, or fail outright
because the host is logged out of the private registry. Delete it and the next deploy
writes it again.
