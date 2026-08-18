#!/bin/sh
set -e

# Apply pending migrations before serving, unless told not to.
#
# Safe for the single-container deployment this image is built for. If you ever
# run more than one replica, set RUN_MIGRATIONS=false and migrate once as a
# separate step instead — concurrent `migrate deploy` against one database is a
# race, and Prisma's advisory lock will make the losers fail their startup rather
# than wait politely.
if [ "${RUN_MIGRATIONS:-true}" != "false" ]; then
  echo '[entrypoint] applying migrations'
  # Run from the migrator directory: the CLI resolves prisma.config.ts, its own
  # dependencies, and the migrations directory relative to the working directory.
  (cd ./migrator && node ./node_modules/prisma/build/index.js migrate deploy)
fi

exec "$@"
