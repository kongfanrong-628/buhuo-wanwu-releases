#!/bin/bash
# 只拉模板缩略图分片并解压（长超时版，jsDelivr 国内回源约 14KB/s）
set -e
SHA="599aca7c669c8bfea6fb625e2587fe87e7e90631"
BASE="https://cdn.jsdelivr.net/gh/kongfanrong-628/buhuo-wanwu-releases@${SHA}/kbh/patch/tpl_parts"
cd /www/wwwroot/kbh/kbh-web
mkdir -p _parts_tmp 模板/贴图
rm -f _parts_tmp/part_*

echo "=== 拉取 9 个分片（每个 max-time 300s）==="
for i in 00 01 02 03 04 05 06 07 08; do
  echo -n "part_$i ... "
  curl -fsSL --max-time 300 -o "_parts_tmp/part_$i" "$BASE/part_$i"
  echo "$(wc -c < _parts_tmp/part_$i) bytes"
done

echo "=== 合并 sha 校验 ==="
cat _parts_tmp/part_00 _parts_tmp/part_01 _parts_tmp/part_02 _parts_tmp/part_03 _parts_tmp/part_04 \
    _parts_tmp/part_05 _parts_tmp/part_06 _parts_tmp/part_07 _parts_tmp/part_08 > _parts_tmp/tpl.zip
ACTUAL=$(sha256sum _parts_tmp/tpl.zip | awk '{print $1}')
echo "sha=$ACTUAL"
[ "$ACTUAL" = "261a8d96df6654ff006de0ce900be7ce7ed8bc834d28238113e9b1ba533976d8" ] || { echo "SHA_MISMATCH"; exit 1; }

echo "=== 解压 ==="
unzip -oq _parts_tmp/tpl.zip -d 模板/贴图
echo "模板图片数: $(find 模板/贴图 -type f | wc -l)"
echo "=== 端点实测 ==="
curl -s -o /dev/null -w 'tpl-img HTTP:%{http_code} SIZE:%{size_download} TYPE:%{content_type}\n' \
  "http://127.0.0.1:8899/api/tpl-img?path=%E9%A6%96%E5%9B%BE%2F%E4%BA%BA%E6%96%87%E5%8E%86%E5%8F%B2%2F1%20(1).webp"
echo "TPL_DONE"
