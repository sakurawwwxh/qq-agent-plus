# QQ Agent Plus —— 应用镜像
#
# 只装运行期依赖；测试、文档、devDependencies 都在 .dockerignore 里排除。
# 入口先以 root 修正数据卷属主，再降权到 node 运行（见 docker/entrypoint.sh）。
#
# 国内网络：Docker Hub 不可直连时，用镜像站构建基础镜像层：
#   docker build --build-arg NODE_IMAGE=docker.1panel.live/library/node:22.23.3-bookworm-slim .
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
FROM ${NODE_IMAGE}

# gosu：启动时降权；tzdata：控制台的本地时间与日志时区；ffmpeg：媒体处理
# （音频转写、视频抽帧、GIF 帧条、大图降采样）。ffmpeg 的依赖会让镜像大约多 470MB；
# 这是保留完整功能的代价，不提供精简变体。
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu tzdata ffmpeg \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    QQ_AGENT_DATA_DIR=/data \
    QQ_AGENT_RUNTIME=docker \
    TZ=Asia/Shanghai

WORKDIR /app

# 先装依赖再拷源码：改业务代码时不必重装 node_modules。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY . .
RUN chmod 0755 docker/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /data /app

LABEL org.opencontainers.image.title="QQ Agent Plus" \
      org.opencontainers.image.description="Linux QQ group agent (OneBot v11) with a web console" \
      org.opencontainers.image.source="https://github.com/sakurawwwxh/qq-agent-plus" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 3210
STOPSIGNAL SIGTERM

# /healthz 是现成的免鉴权存活端点（只返回名称/版本/连接状态，不含配置）。
# 端口跟随 QQ_AGENT_SERVER_PORT，避免用户改端口后健康检查永远红。
HEALTHCHECK --interval=30s --timeout=5s --start-period=150s --retries=3 \
  CMD node -e "const p=process.env.QQ_AGENT_SERVER_PORT||3210;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口以 root 开始，chown 数据卷后 exec 成 node；应用进程不是 root。
ENTRYPOINT ["/app/docker/entrypoint.sh"]
