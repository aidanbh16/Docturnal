#!/usr/bin/env bash
# Builds a scratch repository with 60 source files in 4 folders, for testing Docturnal's
# parallel workflow on GitHub. The files import each other, so the backlog's ranking has an
# import graph to work with, and a few odd paths cover spaces, Unicode, and CRLF.
#
# Usage: bash test/github/make-scratch-repo.sh <directory> [--create owner/name] [--private]
#   --create  also creates the repository on GitHub with the gh CLI and pushes it.
#   --private makes that repository private (2 work jobs instead of up to 8).
set -euo pipefail

dir="${1:?Usage: make-scratch-repo.sh <directory> [--create owner/name] [--private]}"
shift
create=""
visibility="--public"
while [ $# -gt 0 ]; do
  case "$1" in
    --create) create="${2:?--create needs owner/name}"; shift 2 ;;
    --private) visibility="--private"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -e "$dir" ]; then
  echo "$dir already exists. Choose a new directory." >&2
  exit 1
fi
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dir"
cd "$dir"
git init -q -b main
git config core.autocrlf false

cat > package.json <<'EOF'
{
  "name": "scratch-shop",
  "version": "1.0.0",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  }
}
EOF
printf '# Scratch shop\n\nA small shop service for testing.\n' > README.md

mkdir -p src/api src/core src/data src/util

# 15 helpers in src/util: imported by nearly everything, so they rank high on fan-in.
for i in $(seq 1 15); do
  cat > "src/util/helper$i.js" <<EOF
'use strict';

function clamp$i(value, low, high) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

function round$i(value, places = $((i % 4))) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

module.exports = { clamp$i, round$i };
EOF
done

# 15 models in src/data, each using one helper.
for i in $(seq 1 15); do
  cat > "src/data/model$i.js" <<EOF
'use strict';

const { clamp$i } = require('../util/helper$i');

class Model$i {
  constructor(rows = []) {
    this.rows = rows;
  }

  add(row) {
    if (!row || typeof row.id !== 'number') throw new Error('Each row needs a numeric id.');
    this.rows.push({ ...row, score: clamp$i(row.score || 0, 0, 100) });
    return this.rows.length;
  }

  find(id) {
    return this.rows.find((row) => row.id === id) || null;
  }

  top(count) {
    return [...this.rows].sort((a, b) => b.score - a.score).slice(0, count);
  }
}

module.exports = { Model$i };
EOF
done

# 15 services in src/core, each using a model and a helper, with some branching.
for i in $(seq 1 15); do
  cat > "src/core/service$i.ts" <<EOF
import { Model$i } from '../data/model$i';
import { round$i } from '../util/helper$i';

export interface Order$i {
  id: number;
  total: number;
  coupon?: string;
}

export function priceOrder$i(order: Order$i, taxRate: number): number {
  let total = order.total;
  if (order.coupon === 'HALF') {
    total = total / 2;
  } else if (order.coupon && order.coupon.startsWith('OFF')) {
    const off = Number(order.coupon.slice(3));
    if (!Number.isNaN(off)) total = Math.max(0, total - off);
  }
  for (let attempt = 0; attempt < 3 && total < 0; attempt++) total = 0;
  return round$i(total * (1 + taxRate));
}

export function rankOrders$i(orders: Order$i[]): number[] {
  const model = new Model$i(orders.map((o) => ({ id: o.id, score: o.total })));
  return model.top(5).map((row: { id: number }) => row.id);
}
EOF
done

# 12 Python handlers in src/api.
for i in $(seq 1 12); do
  cat > "src/api/handler_$i.py" <<EOF
import json


def parse_request_$i(body):
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if not isinstance(data, dict) or "id" not in data:
        return None
    return data


def handle_$i(body):
    data = parse_request_$i(body)
    if data is None:
        return {"status": 400}
    retries = 0
    while retries < 3 and data.get("busy"):
        retries += 1
    return {"status": 200, "id": data["id"], "retries": retries}
EOF
done

# The entry point, which imports the services.
{
  echo "'use strict';"
  echo
  for i in 1 2 3 4 5; do echo "const service$i = require('./core/service$i');"; done
  echo
  echo "function main() {"
  echo "  const services = [service1, service2, service3, service4, service5];"
  echo "  console.log(\`Loaded \${services.length} services.\`);"
  echo "}"
  echo
  echo "main();"
} > src/index.js

# Odd paths: a space, Unicode, and Windows line endings.
mkdir -p "src/util/date tools"
printf "'use strict';\n\nfunction isoDay(date) {\n  return date.toISOString().slice(0, 10);\n}\n\nmodule.exports = { isoDay };\n" > "src/util/date tools/iso day.js"
printf "'use strict';\n\nfunction grüße(name) {\n  return 'Hallo, ' + name;\n}\n\nmodule.exports = { grüße };\n" > "src/util/grüße.js"
printf "'use strict';\r\n\r\nfunction windowsLines(text) {\r\n  return text.split('\\\\r\\\\n');\r\n}\r\n\r\nmodule.exports = { windowsLines };\r\n" > src/util/crlf.js

mkdir -p .github/workflows
cp "$here/docturnal-beta.yml" .github/workflows/docturnal.yml

git add -A
git commit -qm "Scratch shop for testing Docturnal"
count=$(git ls-files 'src/*' | wc -l | tr -d ' ')
echo "Created $dir with $count source files."

if [ -n "$create" ]; then
  gh repo create "$create" "$visibility" --source . --push
  # The finish job opens the pull request with the workflow's token, which needs this setting.
  gh api -X PUT "repos/$create/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null
  echo "Pushed to https://github.com/$create"
fi
