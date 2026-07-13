#!/usr/bin/env bash
# Trickle-backfill The Met: repeat small ingest runs with a pause between them,
# so the API budget is spent over time instead of in one burst (which trips the
# rate limit). The Met resume cursor advances after every run, so each round
# ingests a FRESH slice — rounds accumulate.
#
# Usage:            ./scripts/met-backfill.sh [rounds] [chunk] [pause_seconds]
# Default:          20 rounds x 50 works, 5 min apart  (~1000 works, ~2 h)
# Survive logout:   nohup ./scripts/met-backfill.sh >> ~/met-backfill.log 2>&1 &
set -u

ROUNDS=${1:-20}
CHUNK=${2:-50}
PAUSE=${3:-300}

cd "$(dirname "$0")/.."

for i in $(seq 1 "$ROUNDS"); do
  echo ""
  echo "=== Met backfill round $i/$ROUNDS — $(date) ==="
  CATALOG_LIMIT="$CHUNK" MUSEUM_SOURCES=met npm run ingest
  if [ "$i" -lt "$ROUNDS" ]; then
    echo "--- sleeping ${PAUSE}s before next round ---"
    sleep "$PAUSE"
  fi
done

echo ""
echo "=== Met backfill finished ($ROUNDS rounds x $CHUNK works) — $(date) ==="
