#!/bin/bash
# 网页端 8 项 BUG 修复部署脚本（在服务器 /www/wwwroot/kbh/kbh-web 下执行）
set -e
SHA="599aca7c669c8bfea6fb625e2587fe87e7e90631"
BASE="https://cdn.jsdelivr.net/gh/kongfanrong-628/buhuo-wanwu-releases@${SHA}/kbh/patch"
cd /www/wwwroot/kbh/kbh-web

echo "=== [1/6] 备份现有文件 ==="
mkdir -p _bak_20261127
[ -f web/adapter.js ] && cp web/adapter.js _bak_20261127/adapter.js
[ -f server.py ] && cp server.py _bak_20261127/server.py
echo "backup done"

echo "=== [2/6] 拉取代码文件 ==="
curl -fsSL --max-time 60 "$BASE/adapter.js" -o web/adapter.js
curl -fsSL --max-time 60 "$BASE/server.py" -o server.py
echo "adapter.js $(wc -c < web/adapter.js) bytes / server.py $(wc -c < server.py) bytes"

echo "=== [3/6] 拉取数据文件 ==="
mkdir -p static/data
curl -fsSL --max-time 60 "$BASE/static/data/templates.json" -o static/data/templates.json
curl -fsSL --max-time 60 "$BASE/static/feed_seed.json" -o static/feed_seed.json
echo "templates.json $(wc -c < static/data/templates.json) / feed_seed.json $(wc -c < static/feed_seed.json)"

echo "=== [4/6] 拉取模板缩略图分片并合并 ==="
mkdir -p _parts_tmp
for i in 00 01 02 03 04 05 06 07 08; do
  curl -fsSL --max-time 60 "$BASE/tpl_parts/part_$i" -o "_parts_tmp/part_$i"
  echo "  part_$i $(wc -c < _parts_tmp/part_$i)"
done
cat _parts_tmp/part_00 _parts_tmp/part_01 _parts_tmp/part_02 _parts_tmp/part_03 _parts_tmp/part_04 \
    _parts_tmp/part_05 _parts_tmp/part_06 _parts_tmp/part_07 _parts_tmp/part_08 > _parts_tmp/tpl_thumbs.zip
echo "merged sha: $(sha256sum _parts_tmp/tpl_thumbs.zip | awk '{print $1}')"
[ "$(sha256sum _parts_tmp/tpl_thumbs.zip | awk '{print $1}')" = "261a8d96df6654ff006de0ce900be7ce7ed8bc834d28238113e9b1ba533976d8" ] || { echo "SHA MISMATCH"; exit 1; }

echo "=== [5/6] 解压模板图库 ==="
mkdir -p 模板/贴图
unzip -oq _parts_tmp/tpl_thumbs.zip -d 模板/贴图
echo "模板图片数: $(find 模板/贴图 -type f | wc -l)"

echo "=== [6/6] 校验+重启 ==="
echo "adapter v4特征: $(grep -c 'initWxScanWeb' web/adapter.js) / 模板端点: $(grep -c 'tpl-img' server.py)"
systemctl restart kbh
sleep 4
systemctl is-active kbh
curl -s http://127.0.0.1:8899/api/health | head -c 300
echo
echo "DEPLOY_DONE"
