#!/bin/sh
# لعگاب — تشغيل الخادم (Linux)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js غير مثبت — ثبّته من https://nodejs.org"; exit 1; fi
[ -f config.json ] || cp config.example.json config.json
while true; do
  node server.js
  echo "الخادم توقف — إعادة التشغيل بعد 3 ثوانٍ (Ctrl+C للإيقاف)"; sleep 3
done
