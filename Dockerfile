# Azumi Image Host 容器镜像构建文件
# 说明：用于在Docker中运行服务，默认暴露3000端口；数据与备份目录通过挂载到容器。

FROM node:20
WORKDIR /app

# 安装构建依赖以支持 node-gyp（用于编译 sqlite3 等原生模块）
# - Python3：node-gyp 需要
# - build-essential：包含 make、gcc、g++ 等编译工具
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# 仅复制包信息以优化缓存
COPY package*.json ./
# 指定 Python 路径以确保 node-gyp 能找到 Python3
ENV npm_config_python=/usr/bin/python3
ENV PYTHON=/usr/bin/python3
RUN npm ci --only=production || npm install --production

# 复制源代码
COPY src ./src

# 预创建运行时目录（最终通过卷挂载到宿主机持久化）
RUN mkdir -p /app/data/uploads && mkdir -p /app/backups

ENV NODE_ENV=production
ENV PORT=3000
# ADMIN_USERNAME/ADMIN_PASSWORD/JWT_SECRET 由运行时传入

EXPOSE 3000
CMD ["node", "src/app/server.js"]