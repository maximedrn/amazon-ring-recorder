FROM oven/bun:alpine AS runtime

# Install ffmpeg for video processing.
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Create a non-root user to run the application for better security.
RUN addgroup -S recorder && adduser -S recorder -G recorder

# Install dependencies first to leverage Docker layer caching. 
# Only copy the files needed for installation.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && bun pm cache rm

# Now copy the rest of the application code.
COPY tsconfig.json ./
COPY src/ ./src/

# Create the recordings directory and set ownership to the non-root user.
RUN mkdir -p /app/data/recordings && chown -R recorder:recorder /app

USER recorder

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD pgrep -f "bun" > /dev/null || exit 1

CMD ["bun", "run", "src/index.ts"]
