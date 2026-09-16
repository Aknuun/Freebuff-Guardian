#!/usr/bin/env bash
# release.sh — انتشار نسخه‌ی جدید: bump نسخه، CHANGELOG، کامیت، تگ، push و GitHub Release
#
# استفاده:
#   ./release.sh patch "عنوان کوتاه" "متن کامل توضیحات"
#   ./release.sh minor "قابلیت جدید" "توضیح بلند…"
#   ./release.sh 1.2.3 "نسخه‌ی خاص"
# عنوان کوتاه، اسم تگ/ریلیز می‌شود و متن کامل در توضیحات (body) می‌آید.
set -euo pipefail
cd "$(dirname "$0")"

BUMP="${1:-patch}"
TITLE="${2:-}"
BODY="${3:-$TITLE}"
if [[ -z "$TITLE" ]]; then
  echo "usage: ./release.sh <patch|minor|major|x.y.z> \"عنوان کوتاه\" [\"متن کامل\"]" >&2
  exit 1
fi

CUR=$(node -p "require('./package.json').version")
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$BUMP"
else
  IFS=. read -r MAJ MIN PAT <<< "$CUR"
  case "$BUMP" in
    major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
    minor) MIN=$((MIN + 1)); PAT=0 ;;
    patch) PAT=$((PAT + 1)) ;;
    *) echo "نوع bump نامعتبر: $BUMP" >&2; exit 1 ;;
  esac
  NEW="$MAJ.$MIN.$PAT"
fi
DATE=$(date +%F)

echo "🔖 نسخه‌ی جدید: v$NEW (قبلی: v$CUR)"
echo "   عنوان: $TITLE"

NEW="$NEW" node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
p.version = process.env.NEW;
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
'

NEW="$NEW" DATE="$DATE" TITLE="$TITLE" BODY="$BODY" node -e '
const fs = require("fs");
let s = fs.readFileSync("CHANGELOG.md", "utf8");
const body = process.env.BODY && process.env.BODY !== process.env.TITLE
  ? "\n" + process.env.BODY.split("\n").map((l) => (l ? "  " + l : "")).join("\n") + "\n"
  : "";
const entry = `## [${process.env.NEW}] - ${process.env.DATE}\n\n### Changed\n- ${process.env.TITLE}\n${body}\n`;
const i = s.indexOf("\n## [");
s = i >= 0 ? s.slice(0, i + 1) + entry + s.slice(i + 1) : s + entry;
fs.writeFileSync("CHANGELOG.md", s);
'

git add -A
git commit -m "release: v$NEW — $TITLE"
git tag -a "v$NEW" -m "v$NEW — $TITLE"
git push origin HEAD
git push origin "v$NEW"
echo "✅ تگ v$NEW به گیت‌هاب push شد"

# --- ساخت GitHub Release (اختیاری، اگر توکن موجود باشد) ---
TOKEN=$(sed -nE 's#https://[^:]+:([^@]+)@github.com#\1#p' "$HOME/.git-credentials" 2>/dev/null || true)
SLUG=$(git remote get-url origin | sed -E 's#(git@github.com:|https://([^@]+@)?github.com/)##; s#\.git$##')
if [[ -n "$TOKEN" ]]; then
  PAYLOAD=$(NEW="$NEW" TITLE="$TITLE" BODY="$BODY" node -e '
    process.stdout.write(JSON.stringify({
      tag_name: "v" + process.env.NEW,
      name: "v" + process.env.NEW + " — " + process.env.TITLE,
      body: process.env.BODY || "",
    }));
  ')
  RESP=$(curl -s -o /tmp/gh-release-resp.json -w '%{http_code}' -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$SLUG/releases" \
    -d "$PAYLOAD")
  if [[ "$RESP" == "201" ]]; then
    echo "✅ GitHub Release v$NEW ساخته شد: https://github.com/$SLUG/releases/tag/v$NEW"
  else
    echo "⚠️ ساخت Release ناموفق (HTTP $RESP)؛ تگ push شده است." >&2
  fi
else
  echo "ℹ️ توکن گیت‌هاب پیدا نشد؛ فقط تگ push شد." >&2
fi
