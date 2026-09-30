FROM node:22-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY . .
RUN npm run build && npm prune --omit=dev && mkdir -p /app/artifacts && chown -R node:node /app /ms-playwright
USER node
ENV NODE_ENV=production ENGINE_HOST=0.0.0.0 PORT=3210
EXPOSE 3210
CMD ["npm", "start"]
