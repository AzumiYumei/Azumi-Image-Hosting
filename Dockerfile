# Azumi Image Host 容器镜像构建文件
# 说明：用于在Docker中运行服务，默认暴露8080端口；数据与备份目录通过挂载到容器。

FROM node:20-slim AS base
WORKDIR /app

# 仅复制包信息以优化缓存
COPY package*.json ./
RUN npm ci --only=production || npm install --production

# 复制源代码
COPY src ./src

# 预创建运行时目录（最终通过卷挂载到宿主机持久化）
RUN mkdir -p /app/data/uploads && mkdir -p /app/backups

ENV NODE_ENV=production
ENV PORT=8080
# ADMIN_USERNAME/ADMIN_PASSWORD/JWT_SECRET 由运行时传入

EXPOSE 8080
CMD ["node", "src/app/server.js"]