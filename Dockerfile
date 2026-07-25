# Build with `nix build .#oci`; this source Dockerfile is retained for
# environments that do not consume the flake output.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENTRYPOINT ["node", "src/cli.js"]
