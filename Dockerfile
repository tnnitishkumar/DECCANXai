# NOTE: not yet build-tested in CI (see docs/STATUS.md). Zero npm runtime dependencies:
# Node 22.18+ runs the TypeScript sources natively.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY services ./services
USER node
ENV HOST=0.0.0.0 PORT=8787 DECCANXAI_CONFIG=/config/deccanxai.config.json
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/gateway/src/main.ts"]
