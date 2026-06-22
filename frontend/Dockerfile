FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS dev
WORKDIR /app
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev", "--", "--host", "0.0.0.0"]

FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

FROM deps AS preview
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build ./build
COPY --from=build /app/.svelte-kit ./.svelte-kit
EXPOSE 4173
CMD ["bun", "run", "preview", "--", "--host", "0.0.0.0"]
