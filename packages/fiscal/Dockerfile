# Standalone internal preflight, not an issuance or DGII-facing service.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install --no-install-recommends --yes libxml2-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/fiscal
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node schemas ./schemas
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "src/server.ts"]
