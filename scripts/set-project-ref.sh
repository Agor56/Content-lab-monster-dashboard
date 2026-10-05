#!/usr/bin/env bash
# Points the repo at another Supabase project: ./scripts/set-project-ref.sh <project-ref>
# Rewrites the three places the ref is hard-coded (the app and both cron job URLs).
set -euo pipefail

new="${1:?usage: $0 <supabase-project-ref>}"
[[ "$new" =~ ^[a-z0-9]{20}$ ]] || { echo "A Supabase project ref is 20 lowercase letters and digits." >&2; exit 1; }

cd "$(dirname "$0")/.."
old=$(grep -o 'const SB_PROJECT = "[a-z0-9]*"' app/carousel-engine.html | cut -d'"' -f2)
[[ -n "$old" ]] || { echo "Couldn't find SB_PROJECT in app/carousel-engine.html." >&2; exit 1; }
[[ "$old" != "$new" ]] || { echo "Already pointing at $new."; exit 0; }

files=(app/carousel-engine.html supabase/sql/schema.sql supabase/sql/ig_followup_schema.sql)
for f in "${files[@]}"; do
  sed -i.bak "s/$old/$new/g" "$f" && rm -f "$f.bak"
done
echo "Replaced $old with $new in:"
grep -c "$new" "${files[@]}"
