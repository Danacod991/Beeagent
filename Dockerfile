# Runs `bee voice` as a web service, so the voice agent has a public URL
# instead of living in a terminal. The host platform (Fly, Render, Railway,
# Cloud Run, ...) terminates https, which browsers require before they hand a
# page the microphone.
#
#   docker build -t bee-voice .
#   docker run -p 8080:8080 -e BEE_TOKEN=... -e BEE_VOICE_PASSWORD=... bee-voice
FROM oven/bun:1.4.4-slim AS build
WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json ./
COPY sources ./sources
RUN bun build ./sources/main.ts --compile --outfile ./bee

FROM debian:bookworm-slim
# The compiled binary is self-contained; it still needs CA certificates to
# reach Bee over https.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# An unprivileged user with a home directory, because the CLI keeps its config
# under $HOME even though BEE_TOKEN means nothing is written there.
RUN useradd --create-home --uid 10001 bee
USER bee
WORKDIR /home/bee

COPY --from=build --chown=bee:bee /app/bee /usr/local/bin/bee

# No keychain in a container.
ENV BEE_FORCE_FILE_STORE=1
ENV PORT=8080
EXPOSE 8080

# BEE_TOKEN authenticates as your Bee account and BEE_VOICE_PASSWORD guards the
# page; both are required and are passed in as secrets, never baked in here.
CMD ["sh", "-c", "exec bee voice --host 0.0.0.0 --port \"$PORT\" --no-open"]
