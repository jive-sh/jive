# Builds the single `brain` executable for Linux and runs it in a slim image.
# docker build -t brain . && docker run -p 8787:8787 -v brain-data:/data brain
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run fetch-model && bun build src/main.ts --compile --outfile /brain

FROM debian:bookworm-slim
COPY --from=build /brain /usr/local/bin/brain
ENV BRAIN_HOST=0.0.0.0 BRAIN_PORT=8787 BRAIN_DATA_DIR=/data
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/brain"]
