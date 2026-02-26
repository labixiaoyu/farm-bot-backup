#!/bin/bash

# =================================================================
# 🚜 Terminal Farm 一键部署脚本 (生产环境版)
# 使用说明: sudo bash deploy.sh
# =================================================================

# 1. 基础环境检查
echo "--- 正在检查运行环境 ---"
if ! command -v bun &> /dev/null; then
    echo "错误: 未找到 bun，请先按照 README 安装 bun"
    exit 1
fi

PROJECT_ROOT=$(pwd)
WEB_DIR="$PROJECT_ROOT/web-terminal"
WWW_DIR="/var/www/farm"

# 2. 安装后端依赖
echo "--- 正在安装后端依赖 ---"
bun install

# 3. 安装并构建前端
echo "--- 正在构建前端 Web 界面 ---"
cd "$WEB_DIR"
npm install
# 赋予关键二进制执行权限 (根据您的启动流程添加)
chmod +x node_modules/.bin/* 2>/dev/null || true
npm run build

# 4. 部署静态文件
echo "--- 正在部署静态文件到 $WWW_DIR ---"
mkdir -p "$WWW_DIR"
cp -r dist/* "$WWW_DIR/"
chown -R www-data:www-data "$WWW_DIR"
chmod -R 755 "$WWW_DIR"

# 5. 配置 Systemd 服务
echo "--- 正在配置系统服务 ---"
cd "$PROJECT_ROOT"
# 自动修改服务文件中的路径
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_ROOT|g" farm-api.service
sed -i "s|WorkingDirectory=.*|WorkingDirectory=$PROJECT_ROOT/QRLib-main|g" qrlib.service

# 拷贝并启用服务
cp farm-api.service /etc/systemd/system/
cp qrlib.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable farm-api qrlib
systemctl restart farm-api qrlib

# 6. Nginx 提醒
echo "--- 正在重启 Nginx ---"
if [ -f "farm_v5.conf" ]; then
    cp farm_v5.conf /etc/nginx/conf.d/
    systemctl restart nginx
fi

# 7. 状态检查
echo "--- 部署完成！当前服务状态 ---"
systemctl status farm-api --no-pager
echo "提示: 请确保您的端口 (8888, 2222, 11454) 已在安全组中开放。"
