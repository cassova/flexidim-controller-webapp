FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Retries and generous timeouts: a single dropped connection would otherwise
# fail the whole build with ECONNRESET, and npm gives up after two tries.
RUN npm ci --no-audit --no-fund \
      --fetch-retries=5 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000
COPY . .
RUN npm run build
# `next` itself is a runtime dependency here: the web host serves the app
# through Next's programmatic API rather than a prebuilt static bundle.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Saved systems and their security keys live here. Mount a volume on it and the
# details survive rebuilds, reboots and a move to another machine.
ENV CONFIG_DIR=/config
# Set ownership while copying. A separate `chown -R /app` makes overlayfs copy
# every runtime file into another layer, adding hundreds of megabytes to each
# rebuilt image.
COPY --chown=node:node --from=build /app/.next ./.next
COPY --chown=node:node --from=build /app/app ./app
COPY --chown=node:node --from=build /app/server ./server
COPY --chown=node:node --from=build /app/bridge ./bridge
COPY --chown=node:node --from=build /app/tools ./tools
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/next.config.ts ./next.config.ts
# 0700: the file inside holds controller security keys in clear text, because
# the protocol needs the literal characters to authenticate.
RUN mkdir -p /config && chown node:node /config && chmod 700 /config
USER node
# No VOLUME instruction on purpose. Both compose services share this image, and
# a VOLUME line would make Docker create a fresh anonymous volume per container
# on every create — `compose down` does not remove those, so each rebuild would
# leak one until the disk fills.
EXPOSE 3000 8765
# The default command supervises both processes, so a plain `docker run` of this
# image is a complete deployment. Compose overrides it per service.
CMD ["node", "server/start-all.mjs"]
